export const MAX_BYTES = 24 * 1024 * 1024;
export const CELL_PAGE_SIZE = 24;
export const JSON_PAGE_SIZE = 96_000;
export const MAX_RICH_TEXT = 32_000;
export const MAX_OUTPUTS = 24;

export const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
export const textOf = (value) => typeof value === 'string' ? value
  : Array.isArray(value) && value.every((part) => typeof part === 'string') ? value.join('') : '';

export function parseNotebook(raw) {
  let value;
  try { value = JSON.parse(raw.replace(/^\uFEFF/, '')); } catch { return { error: 'invalidJson', raw }; }
  if (!isObject(value) || value.nbformat !== 4 || !Array.isArray(value.cells)) {
    return { error: 'invalidNotebook', raw };
  }
  const language = value.metadata?.language_info?.name ?? value.metadata?.kernelspec?.language;
  // Jupyter files without kernelspec metadata are conventionally Python
  // notebooks. Keep an explicit non-Python language intact for read-only
  // preview while allowing the default notebook path to run Python cells.
  return { raw, value, cells: value.cells, language: typeof language === 'string' && language.trim()
    ? language.slice(0, 48) : 'python' };
}

export function plainOutput(output) {
  if (output?.output_type === 'stream') return textOf(output.text);
  if (output?.output_type === 'error') return Array.isArray(output.traceback) && output.traceback.length
    ? output.traceback.filter((item) => typeof item === 'string').join('\n')
    : [output.ename, output.evalue].filter((item) => typeof item === 'string').join(': ');
  return textOf(output?.data?.['text/plain']);
}

export const stripAnsi = (str) => str.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
export const normalize = (str) => str.normalize('NFC').toLowerCase();

export function searchCells(cells, rawQuery) {
  const query = normalize(rawQuery.trim());
  const result = [];
  for (const [index, cell] of cells.entries()) {
    if (!query || normalize(textOf(cell?.source)).includes(query) || (
      Array.isArray(cell?.outputs) && cell.outputs.some((output) => [
        stripAnsi(plainOutput(output)),
        textOf(output?.data?.['text/markdown']),
        textOf(output?.data?.['text/latex'])
      ].some((content) => normalize(content).includes(query)))
    )) result.push(index);
  }
  return result;
}

export function jsonPages(raw) {
  const offsets = [0];
  let offset = 0;
  while (offset + JSON_PAGE_SIZE < raw.length) {
    let next = offset + JSON_PAGE_SIZE;
    const tail = raw.charCodeAt(next - 1);
    if ((tail >= 0xD800 && tail <= 0xDBFF) || (raw[next - 1] === '\r' && raw[next] === '\n')) next -= 1;
    offsets.push(next);
    offset = next;
  }
  return [...offsets, raw.length];
}

export const imageMimes = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const signatures = {
  'image/png': (header) => header.startsWith('\x89PNG\r\n\x1a\n'),
  'image/jpeg': (header) => header.startsWith('\xff\xd8\xff'),
  'image/gif': (header) => /^GIF8[79]a/.test(header),
  'image/webp': (header) => header.startsWith('RIFF') && header.slice(8, 12) === 'WEBP'
};

export function embeddedImage(mime, data) {
  if (!Object.hasOwn(signatures, mime)) return '';
  const source = textOf(data);
  if (!source || source.length > 8 * 1024 * 1024) return '';
  const base64 = source.replace(/\s+/g, '');
  if (base64.length < 16 || base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) return '';
  if (!signatures[mime](atob(base64.slice(0, 16)))) return '';
  return 'data:' + mime + ';base64,' + base64;
}
