import { parseTree, modify, applyEdits } from 'jsonc-parser';
import { textOf } from './notebook-model.js';

export const isPython = (language) => !language || /^python(?:[23]|\s*[23](?:\.\d+)*)?$/i.test(language);
export const MAX_PROJECTION = 256 * 1024;
const sourceLineEndings = (source) => source.replace(/\r\n?/g, '\n');

export function draftCells(notebook) {
  return notebook.cells.map((cell, slot) => ({ id: 'cell:' + slot, slot, cell, source: textOf(cell?.source) }));
}

export function newDraftCell(kind, notebook, entries) {
  // The document view has an opaque origin; randomUUID requires a secure context.
  const randomId = () => Array.from(crypto.getRandomValues(new Uint8Array(16)),
    (byte) => byte.toString(16).padStart(2, '0')).join('');
  const id = randomId();
  const cell = { cell_type: kind, metadata: {}, source: [] };
  if (notebook.value.nbformat_minor >= 5) {
    let cellId = id;
    while (entries.some((entry) => entry.cell?.id === cellId)) cellId = randomId();
    cell.id = cellId;
  }
  if (kind === 'code') Object.assign(cell, { execution_count: null, outputs: [] });
  return { id: 'new:' + id, slot: null, cell, source: '' };
}

export const outputsOf = (entry) => entry.execution ? entry.execution.outputs : entry.cell?.outputs;
export const executionCountOf = (entry) => entry.execution ? entry.execution.count : entry.cell?.execution_count;
export const hasOutputs = (entry) => !!outputsOf(entry)?.length || executionCountOf(entry) != null;

export function executionBatch(entries, scope, anchor) {
  const index = entries.indexOf(anchor);
  if (scope !== 'all' && index < 0) return [];
  const range = scope === 'above' ? entries.slice(0, index) :
    scope === 'below' ? entries.slice(index) : scope === 'one' ? [anchor] : entries;
  return range.filter((entry) => entry.cell?.cell_type === 'code' && entry.source.trim());
}

export function serializeDraft(raw, entries) {
  const bom = raw.startsWith('\uFEFF') ? '\uFEFF' : '';
  const json = raw.slice(bom.length);
  const tree = parseTree(json);
  const arrays = tree?.children?.filter((child) => child.children?.[0]?.value === 'cells');
  const array = arrays?.length === 1 && arrays[0].children[1];
  if (array?.type !== 'array') throw new Error('Ambiguous notebook cells');
  const slots = array.children ?? [];
  if (!slots.length && !entries.length) return raw;
  const start = slots[0]?.offset ?? array.offset + 1;
  const last = slots.at(-1);
  const end = last ? last.offset + last.length : array.offset + array.length - 1;
  const separator = slots.length > 1
    ? json.slice(slots[0].offset + slots[0].length, slots[1].offset)
    : ',' + json.slice(array.offset + 1, start);
  const pieces = [bom, json.slice(0, start)];
  for (const [index, entry] of entries.entries()) {
    if (index) pieces.push(separator);
    if (entry.slot === null) {
      const cell = { ...entry.cell, source: entry.source.match(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/g) ?? [] };
      if (entry.execution) Object.assign(cell, { outputs: entry.execution.outputs, execution_count: entry.execution.count });
      pieces.push(JSON.stringify(cell));
      continue;
    }
    const original = slots[entry.slot];
    if (!original) throw new Error('Missing source cell');
    let cell = json.slice(original.offset, original.offset + original.length);
    const patches = [];
    const missing = [];
    const replaceField = (name, value) => {
      const fields = original.children?.filter((child) => child.children?.[0]?.value === name) ?? [];
      if (fields.length > 1) throw new Error('Ambiguous notebook field: ' + name);
      const field = fields[0]?.children[1];
      if (field) patches.push({ offset: field.offset - original.offset, length: field.length, content: JSON.stringify(value) });
      else missing.push([name, value]);
    };
    if (entry.source !== textOf(entry.cell?.source)) {
      const source = Array.isArray(entry.cell?.source)
        ? entry.source.match(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/g) ?? [] : entry.source;
      replaceField('source', source);
    }
    if (entry.execution) {
      replaceField('outputs', entry.execution.outputs);
      replaceField('execution_count', entry.execution.count);
    }
    cell = applyEdits(cell, patches);
    for (const [name, value] of missing) cell = applyEdits(cell, modify(cell, [name], value, {}));
    pieces.push(cell);
  }
  pieces.push(json.slice(end));
  return pieces.join('');
}

export function projectPython(entries, edited, value) {
  const ranges = [];
  const chunks = [];
  let line = 0;
  let length = 0;
  for (const entry of entries) {
    if (entry.cell?.cell_type !== 'code') continue;
    const source = sourceLineEndings(entry === edited ? value : entry.source);
    length += source.length + 3;
    if (length > MAX_PROJECTION) return null;
    const lines = source.split('\n');
    // Keep UTF-16 positions. Cell magics may contain a different language.
    const cellMagic = /^\s*%%/.test(source);
    const clean = lines.map((value) => cellMagic || /^\s*[%!?]/.test(value)
      ? value.replace(/[^\t ]/g, ' ') : value);
    ranges.push({ entry, line, lines: clean, sourceLines: lines });
    chunks.push(clean.join('\n') + '\n\n');
    line += lines.length + 1;
  }
  return { text: chunks.join(''), ranges };
}

export function mapDiagnostics(projection, items) {
  const mapped = new Map();
  for (const item of items) {
    const range = projection.ranges.find(({ line, lines }) => item.line >= line && item.line < line + lines.length);
    if (!range) continue;
    const line = item.line - range.line;
    if (range.lines[line] !== range.sourceLines[line] || item.character > range.lines[line].length) continue;
    if (!mapped.has(range.entry)) mapped.set(range.entry, []);
    mapped.get(range.entry).push({ ...item, line });
  }
  return mapped;
}
