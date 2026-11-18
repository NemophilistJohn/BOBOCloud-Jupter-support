import { parseTree, modify, applyEdits } from 'jsonc-parser';
import { textOf } from './notebook-model.js';

export const isPython = (language) => !language || /^python(?:[23]|\s*[23](?:\.\d+)*)?$/i.test(language);
export const MAX_PROJECTION = 256 * 1024;
const sourceLineEndings = (source) => source.replace(/\r\n?/g, '\n');

export function draftCells(notebook) {
  return notebook.cells.map((cell, slot) => ({ slot, cell, source: textOf(cell?.source) }));
}

export function serializeDraft(raw, entries) {
  const bom = raw.startsWith('\uFEFF') ? '\uFEFF' : '';
  const json = raw.slice(bom.length);
  const tree = parseTree(json);
  const arrays = tree?.children?.filter((child) => child.children?.[0]?.value === 'cells');
  const slots = arrays?.length === 1 && arrays[0].children[1].children;
  if (!slots || slots.length !== entries.length) throw new Error('Ambiguous notebook cells');
  let end = 0;
  const pieces = [bom];
  for (const [index, entry] of entries.entries()) {
    const target = slots[index];
    const original = slots[entry.slot];
    pieces.push(json.slice(end, target.offset));
    let cell = json.slice(original.offset, original.offset + original.length);
    if (entry.source !== textOf(entry.cell?.source)) {
      const fields = original.children?.filter((child) => child.children?.[0]?.value === 'source');
      if (fields?.length > 1) throw new Error('Ambiguous notebook source');
      const source = Array.isArray(entry.cell?.source)
        ? entry.source.match(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/g) ?? [] : entry.source;
      const field = fields?.[0]?.children[1];
      if (field) {
        const offset = field.offset - original.offset;
        cell = cell.slice(0, offset) + JSON.stringify(source) + cell.slice(offset + field.length);
      } else {
        cell = applyEdits(cell, modify(cell, ['source'], source, {}));
      }
    }
    pieces.push(cell);
    end = target.offset + target.length;
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
