export function createCellEditor({ entry, edit, t, onChange, complete, finish }) {
  const wrapper = document.createElement('div');
  wrapper.className = 'nb-editor';
  const input = document.createElement('textarea');
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
  wrapper.append(input, popup, feedback);
  let generation = 0;
  let active = 0;
  let choices = [];
  let timer;

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

  async function suggest(explicit) {
    if (!complete || input.readOnly || input.selectionStart !== input.selectionEnd) return;
    const id = ++generation;
    const cursor = input.selectionStart;
    const value = input.value;
    if (explicit) feedback.textContent = t('analyzing');
    let items;
    try { items = await complete(cursor, value); } catch { items = []; }
    if (generation !== id || !input.isConnected || document.activeElement !== input || cursor !== input.selectionStart ||
        input.selectionEnd !== cursor || input.value !== value || input.readOnly) return;
    choices = Array.isArray(items) ? items : [];
    feedback.textContent = choices.length || !explicit ? '' : t('noSuggestions');
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
    popup.hidden = !choices.length;
    active = 0;
    if (!popup.hidden) showChoice();
  }

  function changed(trigger) {
    close();
    selection();
    onChange(input.value);
    if (trigger && complete) timer = setTimeout(() => void suggest(false), 320);
  }

  input.addEventListener('input', (event) => changed(!event.isComposing && event.data === '.'));
  input.addEventListener('compositionend', () => changed(false));
  input.addEventListener('select', selection);
  input.addEventListener('click', () => { selection(); close(); });
  input.addEventListener('keyup', selection);
  input.addEventListener('blur', close);
  input.addEventListener('keydown', (event) => {
    if (event.isComposing || input.readOnly) return;
    if (event.ctrlKey && event.code === 'Space' && complete) {
      event.preventDefault();
      void suggest(true);
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
    } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
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
  return wrapper;
}
