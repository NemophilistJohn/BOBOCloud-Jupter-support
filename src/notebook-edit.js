import { parseTree, modify, applyEdits } from 'jsonc-parser';
import { textOf } from './notebook-model.js';

export const isPython = (language) => !language || /^python(?:[23]|\s*[23](?:\.\d+)*)?$/i.test(language);
export const MAX_PROJECTION = 256 * 1024;
const sourceLineEndings = (source) => source.replace(/\r\n?/g, '\n');

export function draftCells(notebook) {
  return notebook.cells.map((cell, slot) => ({ id: 'cell:' + slot, slot, cell, source: textOf(cell?.source) }));
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
  if (entries.length > slots.length) throw new Error('Missing source cells');
  if (!slots.length) return raw;
  const pieces = [bom, json.slice(0, slots[0].offset)];
  for (const [index, entry] of entries.entries()) {
    const original = slots[entry.slot];
    if (!original) throw new Error('Missing source cell');
    if (index > 0) {
      const previous = slots[index - 1];
      pieces.push(json.slice(previous.offset + previous.length, slots[index].offset));
    }
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
  const last = slots.at(-1);
  pieces.push(json.slice(last.offset + last.length));
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
