import { ArrowDown, ArrowUp, Check, ChevronLeft, ChevronRight, ChevronsDown, ChevronsUp, Eraser,
  FileCode, FileText, ListEnd, ListStart, Pencil, Play, Plus, RotateCcw, Save, Search, SkipForward, Trash2, Undo2, X, createElement } from 'lucide';
import { CELL_PAGE_SIZE, embeddedImage, imageMimes, jsonPages, MAX_BYTES, MAX_OUTPUTS, MAX_RICH_TEXT,
  parseNotebook, plainOutput, searchCells, stripAnsi, textOf } from './notebook-model.js';
import { markdownMarkup, mathMarkup, staticOutput } from './rich-content.js';
import { draftCells, executionBatch, executionCountOf, hasOutputs, isPython, mapDiagnostics, newDraftCell,
  outputsOf, projectPython, serializeDraft } from './notebook-edit.js';
import { highlightCode } from './highlight.js';
import { createCellEditor } from './cell-editor.js';

function node(tag, className, text) {
  const result = document.createElement(tag);
  if (className) result.className = className;
  if (text !== undefined) result.textContent = text;
  return result;
}

function icon(definition) {
  return createElement(definition, { width: 15, height: 15, 'aria-hidden': 'true' });
}

export async function activate(context) {
  const { root, i18n } = context;
  const t = (key, values) => i18n.t(key, values);
  const styling = node('link');
  styling.rel = 'stylesheet';
  styling.href = context.assets.url('dist/view.css');
  document.head.append(styling);

  const view = node('div', 'nb');
  const header = node('header', 'nb-header');
  const identity = node('div', 'nb-identity');
  const filename = node('h1', '', context.document.name);
  filename.title = context.document.name;
  identity.append(filename);
  const toolbar = node('div', 'nb-toolbar');
  const saveStatus = node('span', 'nb-save-status');
  saveStatus.setAttribute('role', 'status');
  const searchBox = node('label', 'nb-search');
  const search = node('input');
  search.type = 'search';
  search.maxLength = 240;
  searchBox.append(icon(Search), search);
  const utilities = node('div', 'nb-utilities');
  const runStatus = node('span', 'nb-run-status');
  runStatus.setAttribute('role', 'status');
  const counter = node('span', 'nb-count');
  counter.setAttribute('role', 'status');
  const pager = node('div', 'nb-pager');
  const pageLabel = node('span', 'nb-page');
  const content = node('main', 'nb-body');
  header.append(identity, toolbar);
  view.append(header, content);
  root.replaceChildren(view);

  let notebook;
  let result = [];
  let offsets = [0, 0];
  let mode = 'preview';
  let cellPage = 0;
  let rawPage = 0;
  let searchTimer;
  let entries = [];
  let edit;
  let saving;
  let saveMessage = '';
  let running;
  let restarting = false;
  let kernelMessage;
  let analysisTimer;
  let revision = 0;
  let projection;
  let analysisWork = Promise.resolve();
  let valid = true;
  let diagnostics = new Map();
  const dirtyEntries = new Set();
  let undo;
  const openOverrides = new Map();
  const currentDetails = new Map();
  const labels = [];

  function button(key, glyph, action, persistent = true) {
    const control = node('button', 'nb-icon-button');
    control.type = 'button';
    control.append(icon(glyph));
    const localize = () => {
      control.title = t(key);
      control.setAttribute('aria-label', t(key));
    };
    localize();
    if (persistent) labels.push(localize);
    control.addEventListener('click', action);
    return control;
  }

  function setMode(next) {
    if (mode === next || (next === 'json' && notebook?.raw === undefined)) return;
    mode = next;
    draw();
  }
  const collapse = button('collapse', ChevronsUp, () => setPageOpen(false));
  const expand = button('expand', ChevronsDown, () => setPageOpen(true));
  const runAll = button('runAll', SkipForward, () => void run('all'));
  const restart = button('restartKernel', RotateCcw, () => void restartKernel());
  const clearAll = button('clearAllOutputs', Eraser, () => clearOutput(entries));
  const appendCode = button('appendCode', FileCode, () => insertCell('code', entries.length));
  const appendMarkdownButton = button('appendMarkdown', FileText, () => insertCell('markdown', entries.length));
  appendCode.dataset.kind = 'code';
  appendMarkdownButton.dataset.kind = 'markdown';
  function shiftPage(offset) {
    if (mode === 'preview') cellPage += offset;
    else rawPage += offset;
    draw();
    (offset < 0 ? (previous.disabled ? next : previous) : (next.disabled ? previous : next)).focus();
  }
  const previous = button('previous', ChevronLeft, () => shiftPage(-1));
  const next = button('next', ChevronRight, () => shiftPage(1));
  const saveButton = button('save', Save, () => void save());
  const undoButton = button('undoCellAction', Undo2, undoAction);
  saveButton.hidden = !context.writeText;
  identity.append(saveStatus, runStatus);
  pager.append(previous, pageLabel, next);
  utilities.append(collapse, expand, runAll, restart, clearAll, appendCode, appendMarkdownButton, undoButton, saveButton, counter, pager);
  toolbar.append(searchBox, utilities);
  search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      cellPage = 0;
      refresh();
    }, 90);
  });

  function dirty() {
    return !!notebook?.cells && (entries.length !== notebook.cells.length ||
      dirtyEntries.size > 0 || entries.some((entry, index) => entry.slot !== index));
  }

  function syncStatus() {
    const pending = dirty();
    context.setDirty?.(pending);
    view.dataset.dirty = String(pending);
    const locked = !!saving || !!running || restarting;
    saveButton.disabled = !pending || locked;
    undoButton.hidden = !undo;
    undoButton.disabled = locked;
    runAll.disabled = locked || !executionBatch(entries, 'all').length;
    restart.disabled = !!saving || restarting;
    clearAll.disabled = locked || !entries.some(hasOutputs);
    appendCode.disabled = appendMarkdownButton.disabled = locked;
    runStatus.textContent = kernelMessage ? t(kernelMessage.key, kernelMessage.values) : '';
    runStatus.classList.toggle('nb-error', !!kernelMessage?.error);
    view.toggleAttribute('data-running', !!running || restarting);
    const input = content.querySelector('textarea');
    if (input) input.readOnly = locked;
    for (const control of view.querySelectorAll('.nb-cell-actions button, .nb-run-cell, .nb-insert button')) {
      if (control.dataset.inactive === undefined) control.dataset.inactive = String(control.disabled);
      control.disabled = locked || control.dataset.inactive === 'true';
    }
    saveStatus.textContent = saveMessage ? t(saveMessage) : pending ? t('unsaved') : '';
    saveStatus.classList.toggle('nb-error', ['saveConflict', 'saveFailed'].includes(saveMessage));
  }

  function refresh(anchor, selector, preserveScroll = false) {
    const scrollTop = content.scrollTop;
    result = searchCells(entries.map((entry) => ({
      ...entry.cell, source: entry.source, outputs: outputsOf(entry)
    })), search.value);
    const index = anchor ? entries.indexOf(anchor) : -1;
    const position = result.indexOf(index);
    if (position >= 0) cellPage = Math.floor(position / CELL_PAGE_SIZE);
    cellPage = Math.min(cellPage, Math.max(0, Math.ceil(result.length / CELL_PAGE_SIZE) - 1));
    draw();
    if (preserveScroll) content.scrollTop = scrollTop;
    if (anchor && selector) {
      const target = currentDetails.get(anchor)?.querySelector(selector);
      target?.focus({ preventScroll: true });
      target?.scrollIntoView({ block: 'nearest' });
    }
  }

  function markEntry(entry) {
    if (entry.execution || entry.source !== textOf(entry.cell?.source)) dirtyEntries.add(entry);
    else dirtyEntries.delete(entry);
  }

  function updateSource(entry, source) {
    if (entry.source === source) return;
    entry.source = source;
    markEntry(entry);
    if (saveMessage !== 'saveConflict') saveMessage = '';
    syncStatus();
    scheduleAnalysis();
  }

  function leaveEdit(discard) {
    if (!edit || saving || running || restarting) return;
    const { entry, initial } = edit;
    if (discard) updateSource(entry, initial);
    edit = undefined;
    refresh(entry, '[data-action="edit"]');
  }

  function toggleEdit(entry) {
    if (saving || running || restarting || !entry.cell || typeof entry.cell !== 'object' || Array.isArray(entry.cell)) return;
    if (edit?.entry === entry) {
      leaveEdit(false);
      return;
    }
    edit = { entry, initial: entry.source };
    openOverrides.set(entry, true);
    scheduleAnalysis();
    refresh(entry, 'textarea');
  }

  function move(index, delta) {
    if (saving || running || restarting) return;
    const target = index + delta;
    const entry = entries[index];
    const other = entries[target];
    if (!entry || !other) return;
    [entries[index], entries[target]] = [other, entry];
    if (saveMessage !== 'saveConflict') saveMessage = '';
    scheduleAnalysis();
    refresh(entry, edit?.entry === entry ? 'textarea' : '[data-action="move"]');
  }

  function deleteCell(entry) {
    const index = entries.indexOf(entry);
    const next = entries[index + 1];
    entries.splice(index, 1);
    if (edit?.entry === entry) edit = undefined;
    dirtyEntries.delete(entry);
    undo = { type: 'delete', entry, index, next };
    if (saveMessage !== 'saveConflict') saveMessage = '';
    scheduleAnalysis();
    refresh(next ?? entries[index - 1], 'summary');
    if (!entries.length) undoButton.focus();
  }

  function insertCell(kind, index) {
    if (!context.writeText || saving || running || restarting) return;
    const entry = newDraftCell(kind, notebook, entries);
    entries.splice(index, 0, entry);
    edit = { entry, initial: '' };
    openOverrides.set(entry, true);
    clearTimeout(searchTimer);
    search.value = '';
    if (saveMessage !== 'saveConflict') saveMessage = '';
    scheduleAnalysis();
    refresh(entry, 'textarea');
  }

  function clearOutput(targets) {
    if (saving || running || restarting) return;
    const previous = [...new Set(Array.isArray(targets) ? targets : [targets])]
      .filter((entry) => kindOf(entry) === 'code' && hasOutputs(entry))
      .map((entry) => [entry, entry.execution]);
    if (!previous.length) return;
    for (const [entry] of previous) {
      entry.execution = { outputs: [], count: null };
      markEntry(entry);
    }
    undo = { type: 'clear', previous };
    if (saveMessage !== 'saveConflict') saveMessage = '';
    refresh(undefined, undefined, true);
  }

  function undoAction() {
    if (saving || running || restarting || !undo) return;
    const { type, entry, index, next, previous } = undo;
    undo = undefined;
    if (type === 'delete') {
      const before = entries.indexOf(next);
      entries.splice(before >= 0 ? before : Math.min(index, entries.length), 0, entry);
      scheduleAnalysis();
    } else {
      for (const [cell, execution] of previous) {
        cell.execution = execution;
        markEntry(cell);
      }
      return refresh(undefined, undefined, true);
    }
    markEntry(entry);
    refresh(entry, edit?.entry === entry ? 'textarea' : 'summary');
  }

  function setKernelMessage(key, values, error = false) {
    kernelMessage = { key, values, error };
    syncStatus();
  }

  async function run(scope, anchor) {
    if (!context.execute || saving || running || restarting) return;
    const batch = executionBatch(entries, scope, anchor);
    if (!batch.length) return;
    if (dirty() && !await save()) {
      if (valid) setKernelMessage('saveBeforeRun', undefined, true);
      return;
    }
    if (!valid || running || restarting) return;
    const operation = {};
    running = operation;
    try {
      for (const entry of batch) {
        const cell = entries.indexOf(entry) + 1;
        setKernelMessage('runningCell', { cell });
        const result = await context.execute({ kind: 'execute', code: entry.source });
        if (!valid || running !== operation) return;
        if (!result?.ok) {
          const code = result?.code;
          const key = code === 'dependencies_unavailable' ? 'kernelDependencies' :
            code === 'resource_pressure' || code === 'container_unavailable' ? 'kernelCapacity' :
            code === 'kernel_closed' ? 'kernelClosed' : code === 'cell_timeout' ? 'kernelTimeout' :
            code === 'network_error' || code === 'not_configured' || code === 'unauthorized' ? 'kernelConnection' :
            code === 'invalid_runtime' ? 'kernelRuntime' : code === 'sync_failed' ? 'kernelSync' :
            code === 'workspace_missing' || code === 'workspace_denied' || code === 'workspace_copy_failed' ||
              code === 'workspace_in_use' ? 'kernelWorkspace' :
            code === 'invalid_cell' ? 'kernelInvalidCell' : 'kernelFailed';
          setKernelMessage(key, { cell }, true);
          return;
        }
        // A previous clear must not undo the newly computed output.
        if (undo?.type === 'clear') {
          undo.previous = undo.previous.filter(([target]) => target !== entry);
          if (!undo.previous.length) undo = undefined;
        }
        entry.execution = { outputs: result.outputs, count: result.executionCount };
        markEntry(entry);
        if (saveMessage !== 'saveConflict') saveMessage = '';
        refresh(undefined, undefined, true);
        if (!result.cellOk) {
          setKernelMessage('cellFailed', { cell }, true);
          return;
        }
      }
      setKernelMessage('runFinished');
    } catch {
      if (valid && running === operation) setKernelMessage('kernelFailed', undefined, true);
    } finally {
      if (valid && running === operation) {
        running = undefined;
        draw(true);
      }
    }
  }

  async function restartKernel() {
    if (!context.execute || saving || restarting) return;
    running = undefined;
    restarting = true;
    setKernelMessage('restartingKernel');
    try {
      const result = await context.execute({ kind: 'restart' });
      if (valid) setKernelMessage(result?.ok ? 'kernelRestarted' : 'kernelFailed', undefined, !result?.ok);
    } catch {
      if (valid) setKernelMessage('kernelFailed', undefined, true);
    } finally {
      restarting = false;
      if (valid) draw(true);
    }
  }

  async function save() {
    if (!context.writeText) return false;
    if (running || restarting) return false;
    if (saving) return saving;
    if (!dirty()) return true;
    saving = Promise.resolve().then(async () => {
      try {
        const text = serializeDraft(notebook.raw, entries);
        const response = await context.writeText(text);
        if (!response?.ok) {
          saveMessage = ['DOCUMENT_VIEW_CHANGED', 'DOCUMENT_VIEW_NOT_FOUND'].includes(response?.code) ? 'saveConflict' : 'saveFailed';
          return false;
        }
        notebook = parseNotebook(text);
        offsets = jsonPages(text);
        entries.forEach((entry, slot) => { entry.cell = notebook.cells[slot]; entry.slot = slot; entry.execution = undefined; });
        if (edit) edit.initial = edit.entry.source;
        undo = undefined;
        dirtyEntries.clear();
        saveMessage = 'saved';
        if (mode === 'json') draw();
        return true;
      } catch {
        saveMessage = 'saveFailed';
        return false;
      }
    }).finally(() => {
      saving = undefined;
      const input = content.querySelector('textarea');
      if (input) input.readOnly = false;
      syncStatus();
    });
    const input = content.querySelector('textarea');
    if (input) input.readOnly = true;
    saveMessage = 'saving';
    syncStatus();
    return saving;
  }

  function sendProjection(value) {
    analysisWork = analysisWork.catch(() => {}).then(async () => {
      if (!valid || projection !== value) return;
      await context.analyze({ kind: 'update', revision: value.revision, text: value.text });
    });
    return analysisWork;
  }

  function scheduleAnalysis() {
    if (!context.analyze || !isPython(notebook.language)) return;
    clearTimeout(analysisTimer);
    revision += 1;
    projection = undefined;
    if (diagnostics.size) {
      diagnostics = new Map();
      for (const details of currentDetails.values()) renderDiagnostics(details);
    }
    analysisTimer = setTimeout(() => {
      const current = prepareProjection();
      if (current) void sendProjection(current).catch(() => {});
    }, 180);
  }

  function prepareProjection() {
    if (projection) return projection;
    const current = projectPython(entries);
    if (current) projection = { ...current, revision };
    return projection;
  }

  async function complete(entry, cursor, value) {
    clearTimeout(analysisTimer);
    const current = prepareProjection();
    const range = current?.ranges.find((item) => item.entry === entry);
    if (!range) return [];
    const before = value.slice(0, cursor).split('\n');
    const line = before.length - 1;
    if (range.lines[line] !== range.sourceLines[line]) return [];
    await sendProjection(current);
    if (projection !== current) return [];
    const items = await context.analyze({ kind: 'complete', revision: current.revision,
      line: range.line + line, character: before.at(-1).length });
    return projection === current ? items : [];
  }

  function renderDiagnostics(details) {
    const list = details.querySelector('.nb-diagnostics');
    if (!list) return;
    const items = diagnostics.get(entries[Number(details.dataset.index)]) ?? [];
    list.hidden = !items.length;
    list.replaceChildren(...items.slice(0, 12).map(({ line, character, severity, message }) => {
      const item = node('li', severity === 1 ? 'nb-error' : '', t('diagnostic', { line: line + 1, text: message }));
      item.title = message;
      item.dataset.column = String(character + 1);
      return item;
    }));
  }

  context.onSave?.(save);
  context.onDiagnostics?.((version, items) => {
    if (!projection || version !== projection.revision || !Array.isArray(items)) return;
    diagnostics = mapDiagnostics(projection, items);
    for (const details of currentDetails.values()) renderDiagnostics(details);
  });
  view.addEventListener('keydown', (event) => {
    if (context.writeText && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      void save();
    }
  });

  function status(key, detail) {
    const section = node('div', 'nb-state', t(key, detail));
    section.setAttribute('role', 'status');
    return section;
  }

  function setPageOpen(open) {
    for (const [index, details] of currentDetails) {
      openOverrides.set(index, open);
      details.open = open;
    }
  }

  function appendText(container, text, className = '') {
    container.append(node('pre', className, text.slice(0, MAX_RICH_TEXT)));
    if (text.length > MAX_RICH_TEXT) container.append(status('truncated'));
  }

  function appendMarkdown(container, text, attachments) {
    const rich = node('div', 'nb-rich');
    rich.innerHTML = markdownMarkup(text, attachments);
    container.append(rich);
    if (text.length > MAX_RICH_TEXT) container.append(status('truncated'));
  }

  function appendOutput(container, output) {
    const slot = node('div', 'nb-output');
    container.append(slot);
    const plain = stripAnsi(plainOutput(output));
    const data = output?.data;
    if (data && typeof data === 'object') {
      for (const mime of imageMimes) {
        const src = embeddedImage(mime, data[mime]);
        if (!src) continue;
        const img = node('img');
        img.alt = t('savedImage');
        img.loading = 'lazy';
        img.decoding = 'async';
        img.addEventListener('error', () => {
          slot.replaceChildren();
          if (plain) appendText(slot, plain);
          else slot.append(status('imageUnavailable'));
        }, { once: true });
        img.src = src;
        slot.append(img);
        return;
      }
      const markdown = textOf(data['text/markdown']);
      if (markdown) return appendMarkdown(slot, markdown);
      const latex = textOf(data['text/latex']).trim();
      if (latex) {
        const formula = node('div', 'nb-rich');
        const delimited = /^(?:\$\$|\$|\\\[|\\\()/.test(latex) ? latex : '$$\n' + latex + '\n$$';
        formula.innerHTML = latex.length > 1500 ? mathMarkup(latex, true) : markdownMarkup(delimited);
        slot.append(formula);
        if (latex.length > 1500) slot.append(status('truncated'));
        return;
      }
      const html = textOf(data['text/html']);
      if (html) {
        const fragment = staticOutput(html);
        if (fragment.textContent.trim()) {
          const rich = node('div', 'nb-rich');
          rich.append(fragment);
          slot.append(rich);
          if (html.length > MAX_RICH_TEXT) slot.append(status('truncated'));
          return;
        }
      }
    }
    if (plain) appendText(slot, plain, output?.output_type === 'error' ? 'nb-error' : '');
    else slot.append(status('unsupportedOutput'));
  }

  function renderCell(index, source, kind) {
    const entry = entries[index];
    const cell = entry.cell;
    const foldedByMetadata = cell?.metadata?.jupyter?.source_hidden === true;
    const details = node('details', 'nb-cell');
    details.id = 'cell-' + (index + 1);
    details.dataset.kind = kind;
    details.dataset.index = String(index);
    details.open = openOverrides.get(entry) ?? (!foldedByMetadata || search.value.trim() !== '');
    let lastOpen = details.open;
    const summary = node('summary');
    const ordinal = node('span', 'nb-ordinal', String(index + 1).padStart(2, '0'));
    const title = node('span', 'nb-kind', t(kind));
    summary.append(ordinal, title);
    if (kind === 'code' && notebook.language) summary.append(node('span', 'nb-cell-meta', notebook.language));
    const execution = executionCountOf(entry);
    if (kind === 'code' && Number.isSafeInteger(execution)) {
      summary.append(node('span', 'nb-execution', '[' + execution + ']'));
    }
    const runnable = kind === 'code' && context.execute && isPython(notebook.language);
    if (context.writeText || runnable) {
      const actions = node('span', 'nb-cell-actions');
      const action = (key, glyph, perform) => button(key, glyph, (event) => {
        event.preventDefault();
        if (!saving && !running && !restarting) perform();
      }, false);
      if (runnable) {
        const above = action('runAbove', ListStart, () => void run('above', entry));
        const below = action('runBelow', ListEnd, () => void run('below', entry));
        above.disabled = !executionBatch(entries, 'above', entry).length;
        below.disabled = !executionBatch(entries, 'below', entry).length;
        actions.append(above, below);
      }
      if (context.writeText) {
      if (edit?.entry === entry) {
        actions.append(action('applyEdit', Check, () => leaveEdit(false)), action('cancelEdit', X, () => leaveEdit(true)));
      } else if (cell && typeof cell === 'object' && !Array.isArray(cell)) {
        const pencil = action('editCell', Pencil, () => toggleEdit(entry));
        pencil.dataset.action = 'edit';
        actions.append(pencil);
      }
      const up = action('moveUp', ArrowUp, () => move(index, -1));
      const down = action('moveDown', ArrowDown, () => move(index, 1));
      up.dataset.action = down.dataset.action = 'move';
      up.disabled = index === 0;
      down.disabled = index + 1 === entries.length;
      actions.append(up, down);
      if (kind === 'code') {
        const clear = action('clearOutput', Eraser, () => clearOutput([entry]));
        clear.disabled = !hasOutputs(entry);
        actions.append(clear);
      }
      const remove = action('deleteCell', Trash2, () => deleteCell(entry));
      remove.classList.add('nb-delete');
      actions.append(remove);
      details.addEventListener('dblclick', (event) => {
        if (event.target.closest('button, .nb-outputs, .nb-diagnostics') || saving) return;
        event.preventDefault();
        toggleEdit(entry);
      });
      }
      summary.append(actions);
    }
    details.append(summary);
    currentDetails.set(entry, details);
    let built = false;
    function materialize() {
      if (!details.open || built) return;
      built = true;
      const body = node('div', 'nb-cell-body');
      if (edit?.entry === entry) {
        const editor = createCellEditor({ entry, edit, t,
          onChange: (text) => updateSource(entry, text),
          complete: kind === 'code' && context.analyze && isPython(notebook.language) ? (cursor, text) => complete(entry, cursor, text) : null,
          finish: () => leaveEdit(false) });
        editor.querySelector('textarea').readOnly = !!saving || !!running || restarting;
        body.append(editor);
      } else if (kind === 'markdown') appendMarkdown(body, source, cell?.attachments);
      else if (kind === 'code') {
        const pre = node('pre', 'nb-code');
        highlightCode(pre, source.slice(0, MAX_RICH_TEXT), notebook.language);
        body.append(pre);
        if (source.length > MAX_RICH_TEXT) body.append(status('truncated'));
      }
      else appendText(body, source);
      if (kind === 'code' && context.analyze) body.append(node('ul', 'nb-diagnostics'));
      const cellOutputs = outputsOf(entry);
      if (Array.isArray(cellOutputs) && cellOutputs.length) {
        const outputs = node('details', 'nb-outputs');
        outputs.open = cell.metadata?.collapsed !== true && cell.metadata?.jupyter?.outputs_hidden !== true;
        outputs.append(node('summary', '', t('outputs', { count: cellOutputs.length })));
        let rendered = false;
        const renderOutputs = () => {
          if (!outputs.open || rendered) return;
          rendered = true;
          for (const output of cellOutputs.slice(0, MAX_OUTPUTS)) appendOutput(outputs, output);
          if (cellOutputs.length > MAX_OUTPUTS) outputs.append(status('truncated'));
        };
        outputs.addEventListener('toggle', renderOutputs);
        renderOutputs();
        body.append(outputs);
      }
      details.append(body);
      renderDiagnostics(details);
    }
    details.addEventListener('toggle', () => {
      if (!details.isConnected) return;
      if (lastOpen !== details.open) openOverrides.set(entry, details.open);
      lastOpen = details.open;
      materialize();
    });
    materialize();
    const row = node('div', 'nb-cell-row');
    if (runnable) {
      const single = button('runCell', Play, () => void run('one', entry), false);
      single.classList.add('nb-run-cell');
      single.disabled = !entry.source.trim();
      row.append(single);
    }
    row.append(details);
    if (context.writeText) {
      const insert = node('div', 'nb-insert');
      for (const [kind, key] of [['code', 'insertCode'], ['markdown', 'insertMarkdown']]) {
        const add = button(key, Plus, () => insertCell(kind, index + 1), false);
        add.dataset.kind = kind;
        add.append(node('span', '', t(key)));
        insert.append(add);
      }
      row.append(insert);
    }
    return row;
  }

  function kindOf(entry) {
    const kind = entry.cell?.cell_type;
    return kind === 'code' || kind === 'markdown' ? kind : 'raw';
  }

  function publishNavigation(visible) {
    context.setNavigation?.({
      providerId: 'bobocloud.notebook-preview.sidebar',
      activeMode: mode,
      modes: [{ id: 'preview', label: t('preview') },
        ...(notebook?.raw === undefined ? [] : [{ id: 'json', label: t('json') }])],
      outlineLabel: t('outline'),
      rows: visible.map((index) => {
        const entry = entries[index];
        const kind = kindOf(entry);
        const label = entry.source.slice(0, 180).trim().replace(/^#{1,6}\s+/, '').split('\n')[0] || t(kind);
        return { id: entry.id, label, number: index + 1, tone: kind === 'code' ? 'amber' : kind === 'markdown' ? 'teal' : 'neutral' };
      })
    });
  }

  context.onNavigate?.((id) => {
    if (id === 'preview' || id === 'json') {
      setMode(id);
      return;
    }
    const entry = entries.find((item) => item.id === id);
    const details = currentDetails.get(entry);
    if (!details) return;
    details.open = true;
    details.querySelector('summary').focus({ preventScroll: true });
    details.scrollIntoView({ block: 'start' });
  });

  function draw(preserveScroll = false) {
    currentDetails.clear();
    const scrollTop = preserveScroll ? content.scrollTop : 0;
    if (!preserveScroll) content.scrollTop = 0;
    for (const update of labels) update();
    syncStatus();
    search.placeholder = t('search');
    search.setAttribute('aria-label', t('search'));
    const showCells = mode === 'preview' && notebook?.cells;
    const visible = showCells ? result.slice(cellPage * CELL_PAGE_SIZE, (cellPage + 1) * CELL_PAGE_SIZE) : [];
    publishNavigation(visible);
    const pages = Math.max(1, mode === 'json' ? offsets.length - 1 : Math.ceil(result.length / CELL_PAGE_SIZE));
    const current = mode === 'json' ? rawPage : cellPage;
    toolbar.hidden = notebook?.raw === undefined;
    searchBox.hidden = !showCells;
    collapse.hidden = expand.hidden = !showCells || !result.length;
    const supportsKernel = showCells && context.execute && isPython(notebook.language);
    runAll.hidden = restart.hidden = !supportsKernel;
    clearAll.hidden = !showCells || !context.writeText;
    appendCode.hidden = appendMarkdownButton.hidden = !showCells || !context.writeText;
    previous.disabled = current === 0;
    next.disabled = current + 1 >= pages;
    pager.hidden = pages === 1;
    pageLabel.textContent = t('page', { page: current + 1, pages });
    counter.textContent = showCells ? t('count', { count: result.length, total: entries.length }) : '';

    if (!notebook || (mode === 'preview' && notebook.error)) {
      content.replaceChildren(status(notebook?.error || 'loading'));
      return;
    }
    if (mode === 'json') {
      const raw = node('pre', 'nb-json', notebook.raw.slice(offsets[rawPage], offsets[rawPage + 1]));
      raw.tabIndex = 0;
      raw.setAttribute('aria-label', t('json'));
      content.replaceChildren(raw);
      return;
    }
    if (!result.length) {
      content.replaceChildren(status(entries.length ? 'noMatches' : 'empty'));
      return;
    }
    const list = node('div', 'nb-cells');
    for (const index of visible) {
      const entry = entries[index];
      list.append(renderCell(index, entry.source, kindOf(entry)));
    }
    content.replaceChildren(list);
    syncStatus();
    if (preserveScroll) content.scrollTop = scrollTop;
  }

  if (context.document.size > MAX_BYTES) notebook = { error: 'tooLarge' };
  draw();
  if (!notebook) {
    try { notebook = parseNotebook(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await context.readAll(MAX_BYTES))); }
    catch (error) { notebook = { error: error instanceof TypeError ? 'invalidEncoding' : 'readFailed' }; }
    if (notebook.cells) entries = draftCells(notebook);
    if (notebook.raw !== undefined) offsets = jsonPages(notebook.raw);
    refresh();
  }
  const subscription = i18n.onDidChange(() => draw(true));
  return () => {
    clearTimeout(searchTimer);
    clearTimeout(analysisTimer);
    valid = false;
    subscription.dispose();
    styling.remove();
    root.replaceChildren();
  };
}
