import { highlightCode, MAX_HIGHLIGHT_LENGTH, pythonCompletions } from './highlight.js';

const COMPLETION_PREFIX = /(?:\.|(?<![\p{ID_Continue}])[_\p{ID_Start}][\p{ID_Continue}]*)$/u;
const MAX_CHOICES = 60;
const POPUP_HEIGHT = 144;
const POPUP_GAP = 3;
const VIEWPORT_MARGIN = 6;
const CARET_EDGE_TOLERANCE = 2;

function caretBounds(input, mirror) {
  const cursor = input.selectionStart;
  const value = input.value;
  const before = value.slice(0, cursor).split('\n');
  const bounds = input.getBoundingClientRect();
  const style = getComputedStyle(input);
  const height = parseFloat(style.lineHeight);
  const line = before.at(-1);
  const lineEnd = value.indexOf('\n', cursor);
  const text = (line + value.slice(cursor, lineEnd < 0 ? value.length : lineEnd)) || ' ';
  if (mirror.textContent !== text) mirror.textContent = text;
  const range = document.createRange();
  range.setStart(mirror.firstChild, line.length);
  range.collapse(true);
  const offset = range.getBoundingClientRect().left - mirror.getBoundingClientRect().left;
  return {
    left: bounds.left + input.clientLeft + parseFloat(style.paddingLeft) + offset - input.scrollLeft,
    top: bounds.top + input.clientTop + parseFloat(style.paddingTop) + (before.length - 1) * height - input.scrollTop,
    height
  };
}

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
  const mirror = document.createElement('span');
  mirror.className = 'nb-caret-mirror';
  mirror.setAttribute('aria-hidden', 'true');
  const feedback = document.createElement('span');
  feedback.className = 'nb-analysis-state';
  feedback.setAttribute('role', 'status');
  if (highlighted) {
    highlighted.className = 'nb-editor-code nb-code';
    highlighted.setAttribute('aria-hidden', 'true');
    surface.append(highlighted);
  }
  surface.append(input);
  wrapper.append(surface, popup, mirror, feedback);
  let generation = 0;
  let active = 0;
  let choices = [];
  let timer;
  let composing = false;
  let tracking;

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
    tracking?.();
    tracking = undefined;
  }

  function selection() {
    edit.start = input.selectionStart;
    edit.end = input.selectionEnd;
  }

  function showChoice() {
    [...popup.children].forEach((item, index) => item.classList.toggle('selected', index === active));
    const item = popup.children[active];
    if (!item) return;
    const bounds = item.getBoundingClientRect();
    const top = popup.getBoundingClientRect().top + popup.clientTop;
    if (bounds.top < top) popup.scrollTop += bounds.top - top;
    else if (bounds.bottom > top + popup.clientHeight) popup.scrollTop += bounds.bottom - top - popup.clientHeight;
  }

  function positionPopup() {
    const body = input.closest('.nb-body');
    if (popup.hidden || !body || input.readOnly || document.activeElement !== input) return close();
    const bodyBounds = body.getBoundingClientRect();
    const viewTop = Math.max(0, bodyBounds.top) + VIEWPORT_MARGIN;
    const viewBottom = Math.min(window.innerHeight, bodyBounds.top + body.clientHeight) - VIEWPORT_MARGIN;
    const viewLeft = Math.max(0, bodyBounds.left) + VIEWPORT_MARGIN;
    const viewRight = Math.min(window.innerWidth, bodyBounds.left + body.clientWidth) - VIEWPORT_MARGIN;
    const bounds = input.getBoundingClientRect();
    const caret = caretBounds(input, mirror);
    const caretBottom = caret.top + caret.height;
    // Scroll offsets and client dimensions round differently at fractional zoom.
    const textLeft = bounds.left + input.clientLeft;
    if (caret.left < Math.max(textLeft, viewLeft) - CARET_EDGE_TOLERANCE ||
        caret.left > Math.min(textLeft + input.clientWidth, viewRight) + CARET_EDGE_TOLERANCE ||
        caretBottom <= Math.max(bounds.top, viewTop) || caret.top >= Math.min(bounds.top + input.clientHeight, viewBottom)) return close();

    popup.style.maxWidth = Math.max(0, viewRight - viewLeft) + 'px';
    const fullHeight = Math.min(POPUP_HEIGHT, popup.scrollHeight + popup.offsetHeight - popup.clientHeight);
    const below = viewBottom - caretBottom - POPUP_GAP;
    const above = caret.top - viewTop - POPUP_GAP;
    const opensAbove = below < fullHeight && above > below;
    const room = opensAbove ? above : below;
    if (room < Math.min(fullHeight, 24)) return close();

    popup.style.maxHeight = Math.min(POPUP_HEIGHT, room) + 'px';
    popup.style.left = Math.max(viewLeft, Math.min(caret.left, viewRight - popup.offsetWidth)) + 'px';
    popup.style.top = (opensAbove ? caret.top - POPUP_GAP - popup.offsetHeight : caretBottom + POPUP_GAP) + 'px';
  }

  function trackPopup() {
    if (tracking) return;
    const events = new AbortController();
    const options = { passive: true, signal: events.signal };
    const body = input.closest('.nb-body');
    body.addEventListener('scroll', positionPopup, options);
    input.addEventListener('scroll', positionPopup, options);
    const observer = new ResizeObserver(positionPopup);
    observer.observe(body);
    observer.observe(input);
    tracking = () => { events.abort(); observer.disconnect(); };
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
    positionPopup();
    if (!popup.hidden) {
      trackPopup();
      showChoice();
    }
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
  return { element: wrapper, dispose: close };
}
