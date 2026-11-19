import { highlightCode, MAX_HIGHLIGHT_LENGTH, pythonCompletions } from './highlight.js';

const COMPLETION_PREFIX = /(?:\.|(?<![\p{ID_Continue}])[_\p{ID_Start}][\p{ID_Continue}]*)$/u;
const MAX_CHOICES = 60;

export function createCellEditor({ entry, edit, t, onChange, complete, finish, language, python }) {
  const wrapper = document.createElement('div');
  wrapper.className = 'nb-editor';
  const surface = document.createElement('div');
  surface.className = 'nb-editor-surface';
  const highlighted = language ? document.createElement('pre') : null;
  const input = document.createElement('textarea');
  input.className = 'nb-editor-input';
  input.value = entry.source;
  input.rows = Math.max(4, Math.min(18, input.value.split('\n').length + 1));
  input.spellcheck = false;
  input.wrap = 'off';
  input.setAttribute('aria-label', t('cellSource'));
  input.setSelectionRange(edit.start ?? 0, edit.end ?? 0);
  const popup = document.createElement('div');
  popup.className = 'nb-suggestions';
  popup.hidden = true;
  popup.setAttribute('aria-label', t('suggestions'));
  const feedback = document.createElement('span');
  feedback.className = 'nb-analysis-state';
  feedback.setAttribute('role', 'status');
  if (highlighted) {
    highlighted.className = 'nb-editor-code nb-code';
    highlighted.setAttribute('aria-hidden', 'true');
    surface.append(highlighted);
  }
  surface.append(input);
  wrapper.append(surface, popup, feedback);
  let generation = 0;
  let active = 0;
  let choices = [];
  let timer;
  let composing = false;

  function syncScroll() {
    if (!highlighted) return;
    highlighted.scrollTop = input.scrollTop;
    highlighted.scrollLeft = input.scrollLeft;
  }

  function paint() {
    if (!highlighted) return;
    const source = input.value;
    highlightCode(highlighted, source.endsWith('\n') ? source + ' ' : source, language);
    syncScroll();
  }

  function close() {
    clearTimeout(timer);
    generation += 1;
    feedback.textContent = '';
    popup.hidden = true;
  }

  function selection() {
    edit.start = input.selectionStart;
    edit.end = input.selectionEnd;
  }

  function showChoice() {
    [...popup.children].forEach((item, index) => item.classList.toggle('selected', index === active));
    popup.children[active]?.scrollIntoView({ block: 'nearest' });
  }

  function accept(index) {
    const choice = choices[index];
    if (!choice || input.readOnly) return;
    const start = input.selectionStart;
    const prefix = /[\p{ID_Continue}]*$/u.exec(input.value.slice(0, start))[0];
    const suffix = /^[\p{ID_Continue}]*/u.exec(input.value.slice(start))[0];
    input.setRangeText(choice.insertText, start - prefix.length, start + suffix.length, 'end');
    input.focus({ preventScroll: true });
    changed(false);
  }

  function renderChoices(items) {
    const selected = popup.hidden ? undefined : choices[active]?.insertText;
    choices = items;
    if (!choices.length) {
      popup.hidden = true;
      return;
    }
    popup.replaceChildren();
    choices.forEach((item, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'nb-suggestion';
      button.tabIndex = -1;
      button.textContent = item.label;
      button.title = item.label;
      button.addEventListener('pointerdown', (event) => event.preventDefault());
      button.addEventListener('click', () => accept(index));
      popup.append(button);
    });
    popup.hidden = false;
    active = Math.max(0, choices.findIndex((item) => item.insertText === selected));
    showChoice();
  }

  function localChoices(cursor, value) {
    if (!python || !highlighted || !cursor || value.length > MAX_HIGHLIGHT_LENGTH) return [];
    const before = value.slice(value.lastIndexOf('\n', cursor - 1) + 1, cursor);
    const match = COMPLETION_PREFIX.exec(before);
    if (!match || match[0] === '.' || /\.\s*$/.test(before.slice(0, match.index)) ||
        /^\s*[%!?]/.test(before) || /^\s*%%/.test(value)) return [];
    const tokens = document.createTreeWalker(highlighted, NodeFilter.SHOW_TEXT);
    for (let remaining = cursor, token; (token = tokens.nextNode());) {
      remaining -= token.length;
      if (remaining > 0) continue;
      const scope = token.parentElement.closest('.hljs-string, .hljs-comment, .hljs-subst');
      return scope && !scope.classList.contains('hljs-subst') ? [] : pythonCompletions(match[0]);
    }
    return [];
  }

  async function suggest(explicit) {
    if ((!python && !complete) || composing || input.readOnly || input.selectionStart !== input.selectionEnd ||
        !input.isConnected || document.activeElement !== input) return;
    clearTimeout(timer);
    const id = ++generation;
    const cursor = input.selectionStart;
    const value = input.value;
    const local = localChoices(cursor, value);
    renderChoices(local);
    feedback.textContent = explicit && !local.length && complete ? t('analyzing') : '';
    let remote = [];
    try { remote = await complete?.(cursor, value); } catch { /* The local choices stay usable. */ }
    if (generation !== id || !input.isConnected || document.activeElement !== input || cursor !== input.selectionStart ||
        input.selectionEnd !== cursor || input.value !== value || input.readOnly) return;
    const merged = new Map(local.map((item) => [item.insertText, item]));
    for (const item of Array.isArray(remote) ? remote : []) {
      if (merged.size >= MAX_CHOICES) break;
      if (typeof item?.insertText === 'string' && typeof item.label === 'string' && !merged.has(item.insertText)) {
        merged.set(item.insertText, item);
      }
    }
    if (merged.size > local.length) renderChoices([...merged.values()]);
    feedback.textContent = merged.size || !explicit ? '' : t('noSuggestions');
  }

  function changed(trigger) {
    close();
    selection();
    paint();
    onChange(input.value);
    if (trigger && (python || complete) && input.selectionStart === input.selectionEnd) {
      const before = input.value.slice(Math.max(0, input.selectionStart - 256), input.selectionStart);
      if (COMPLETION_PREFIX.test(before)) timer = setTimeout(() => void suggest(false), 320);
    }
  }

  input.addEventListener('scroll', syncScroll);
  input.addEventListener('input', (event) => changed(!composing && !event.isComposing &&
    (event.inputType === 'insertText' || event.inputType === 'insertReplacementText')));
  input.addEventListener('compositionstart', () => {
    composing = true;
    close();
    surface.classList.add('nb-editor-composing');
  });
  input.addEventListener('compositionend', () => {
    composing = false;
    surface.classList.remove('nb-editor-composing');
    changed(true);
  });
  input.addEventListener('select', selection);
  input.addEventListener('click', () => { selection(); close(); });
  input.addEventListener('keyup', selection);
  input.addEventListener('blur', close);
  input.addEventListener('keydown', (event) => {
    if (composing || event.isComposing || input.readOnly) return;
    if (event.ctrlKey && event.code === 'Space' && (python || complete)) {
      event.preventDefault();
      void suggest(true);
    } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      finish();
    } else if (!popup.hidden && ['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(event.key)) {
      event.preventDefault();
      if (event.key === 'Escape') close();
      else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        active = (active + choices.length + (event.key === 'ArrowDown' ? 1 : -1)) % choices.length;
        showChoice();
      } else accept(active);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      finish();
    } else if (event.key === 'Enter' && entry.cell.cell_type === 'code') {
      const line = input.value.slice(0, input.selectionStart).split('\n').at(-1);
      const indent = /^\s*/.exec(line)[0] + (line.trimEnd().endsWith(':') ? '    ' : '');
      if (!indent) return;
      event.preventDefault();
      input.setRangeText('\n' + indent, input.selectionStart, input.selectionEnd, 'end');
      changed(false);
    } else if (!['Control', 'Meta', 'Shift', 'Alt'].includes(event.key)) close();
  });
  paint();
  return wrapper;
}
