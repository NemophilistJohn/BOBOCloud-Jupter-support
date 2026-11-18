import { Braces, ChevronLeft, ChevronRight, ChevronsDown, ChevronsUp, Eye, Search, createElement } from 'lucide';
import { CELL_PAGE_SIZE, embeddedImage, imageMimes, jsonPages, MAX_BYTES, MAX_OUTPUTS, MAX_RICH_TEXT,
  parseNotebook, plainOutput, searchCells, stripAnsi, textOf } from './notebook-model.js';
import { markdownMarkup, mathMarkup, staticOutput } from './rich-content.js';

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
  const modeLabel = node('span', 'nb-badge');
  identity.append(filename, modeLabel);
  const toolbar = node('div', 'nb-toolbar');
  const modes = node('div', 'nb-modes');
  const searchBox = node('label', 'nb-search');
  const search = node('input');
  search.type = 'search';
  search.maxLength = 240;
  searchBox.append(icon(Search), search);
  const utilities = node('div', 'nb-utilities');
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
  const openOverrides = new Map();
  const currentDetails = new Map();
  const labels = [];

  function button(key, glyph, action, showLabel = false) {
    const control = node('button', showLabel ? 'nb-mode' : 'nb-icon-button');
    control.type = 'button';
    control.append(icon(glyph));
    const label = node('span');
    if (showLabel) control.append(label);
    labels.push(() => {
      control.title = t(key);
      control.setAttribute('aria-label', t(key));
      label.textContent = t(key);
    });
    control.addEventListener('click', action);
    return control;
  }

  function setMode(next) {
    if (mode === next) return;
    mode = next;
    draw();
  }
  const previewButton = button('preview', Eye, () => setMode('preview'), true);
  const rawButton = button('json', Braces, () => setMode('json'), true);
  modes.append(previewButton, rawButton);
  const collapse = button('collapse', ChevronsUp, () => setPageOpen(false));
  const expand = button('expand', ChevronsDown, () => setPageOpen(true));
  function shiftPage(offset) {
    if (mode === 'preview') cellPage += offset;
    else rawPage += offset;
    draw();
    (offset < 0 ? (previous.disabled ? next : previous) : (next.disabled ? previous : next)).focus();
  }
  const previous = button('previous', ChevronLeft, () => shiftPage(-1));
  const next = button('next', ChevronRight, () => shiftPage(1));
  pager.append(previous, pageLabel, next);
  utilities.append(collapse, expand, counter, pager);
  toolbar.append(modes, searchBox, utilities);
  search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      result = searchCells(notebook.cells, search.value);
      cellPage = 0;
      draw();
    }, 90);
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
    const cell = notebook.cells[index];
    const foldedByMetadata = cell?.metadata?.jupyter?.source_hidden === true;
    const details = node('details', 'nb-cell');
    details.id = 'cell-' + (index + 1);
    details.dataset.kind = kind;
    details.open = openOverrides.get(index) ?? (!foldedByMetadata || search.value.trim() !== '');
    let lastOpen = details.open;
    const summary = node('summary');
    const ordinal = node('span', 'nb-ordinal', String(index + 1).padStart(2, '0'));
    const title = node('span', 'nb-kind', t(kind));
    summary.append(ordinal, title);
    if (kind === 'code' && notebook.language) summary.append(node('span', 'nb-cell-meta', notebook.language));
    const execution = cell?.execution_count;
    if (kind === 'code' && Number.isSafeInteger(execution)) {
      summary.append(node('span', 'nb-execution', '[' + execution + ']'));
    }
    details.append(summary);
    currentDetails.set(index, details);
    let built = false;
    function materialize() {
      if (!details.open || built) return;
      built = true;
      const body = node('div', 'nb-cell-body');
      if (kind === 'markdown') appendMarkdown(body, source, cell?.attachments);
      else appendText(body, source);
      if (Array.isArray(cell?.outputs) && cell.outputs.length) {
        const outputs = node('details', 'nb-outputs');
        outputs.open = cell.metadata?.collapsed !== true && cell.metadata?.jupyter?.outputs_hidden !== true;
        outputs.append(node('summary', '', t('outputs', { count: cell.outputs.length })));
        let rendered = false;
        const renderOutputs = () => {
          if (!outputs.open || rendered) return;
          rendered = true;
          for (const output of cell.outputs.slice(0, MAX_OUTPUTS)) appendOutput(outputs, output);
          if (cell.outputs.length > MAX_OUTPUTS) outputs.append(status('truncated'));
        };
        outputs.addEventListener('toggle', renderOutputs);
        renderOutputs();
        body.append(outputs);
      }
      details.append(body);
    }
    details.addEventListener('toggle', () => {
      if (!details.isConnected) return;
      if (lastOpen !== details.open) openOverrides.set(index, details.open);
      lastOpen = details.open;
      materialize();
    });
    materialize();
    return details;
  }

  function draw() {
    currentDetails.clear();
    content.scrollTop = 0;
    modeLabel.textContent = t('readOnly');
    for (const update of labels) update();
    search.placeholder = t('search');
    search.setAttribute('aria-label', t('search'));
    previewButton.setAttribute('aria-pressed', String(mode === 'preview'));
    rawButton.setAttribute('aria-pressed', String(mode === 'json'));
    const showCells = mode === 'preview' && notebook?.cells;
    const pages = Math.max(1, mode === 'json' ? offsets.length - 1 : Math.ceil(result.length / CELL_PAGE_SIZE));
    const current = mode === 'json' ? rawPage : cellPage;
    toolbar.hidden = notebook?.raw === undefined;
    searchBox.hidden = !showCells;
    collapse.hidden = expand.hidden = !showCells || !result.length;
    previous.disabled = current === 0;
    next.disabled = current + 1 >= pages;
    pager.hidden = pages === 1;
    pageLabel.textContent = t('page', { page: current + 1, pages });
    counter.textContent = showCells ? t('count', { count: result.length, total: notebook.cells.length }) : '';

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
      content.replaceChildren(status(notebook.cells.length ? 'noMatches' : 'empty'));
      return;
    }
    const spread = node('div', 'nb-spread');
    const outline = node('nav', 'nb-outline');
    outline.setAttribute('aria-label', t('outline'));
    outline.append(node('h2', '', t('outline')));
    const list = node('div', 'nb-cells');
    for (const index of result.slice(cellPage * CELL_PAGE_SIZE, (cellPage + 1) * CELL_PAGE_SIZE)) {
      const cell = notebook.cells[index];
      const kind = cell?.cell_type === 'code' || cell?.cell_type === 'markdown' ? cell.cell_type : 'raw';
      const source = textOf(cell?.source);
      const details = renderCell(index, source, kind);
      list.append(details);
      const excerpt = source.slice(0, 180).trim().replace(/^#{1,6}\s+/, '').split('\n')[0] || t(kind);
      const jump = node('button', 'nb-jump');
      jump.type = 'button';
      jump.append(node('span', 'nb-ordinal', String(index + 1)), node('span', 'nb-excerpt', excerpt));
      jump.title = excerpt;
      jump.addEventListener('click', () => {
        details.open = true;
        details.querySelector('summary').focus({ preventScroll: true });
        details.scrollIntoView({ block: 'start' });
      });
      outline.append(jump);
    }
    spread.append(outline, list);
    content.replaceChildren(spread);
  }

  if (context.document.size > MAX_BYTES) notebook = { error: 'tooLarge' };
  draw();
  if (!notebook) {
    try { notebook = parseNotebook(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await context.readAll(MAX_BYTES))); }
    catch (error) { notebook = { error: error instanceof TypeError ? 'invalidEncoding' : 'readFailed' }; }
    if (notebook.cells) result = searchCells(notebook.cells, '');
    if (notebook.raw !== undefined) offsets = jsonPages(notebook.raw);
    draw();
  }
  const subscription = i18n.onDidChange(draw);
  return () => {
    clearTimeout(searchTimer);
    subscription.dispose();
    styling.remove();
    root.replaceChildren();
  };
}
