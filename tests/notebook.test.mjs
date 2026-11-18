import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { unzipSync } from 'fflate';
import { embeddedImage, jsonPages, JSON_PAGE_SIZE, parseNotebook, searchCells } from '../src/notebook-model.js';
import { markdownMarkup } from '../src/rich-content.js';
import { draftCells, executionBatch, mapDiagnostics, projectPython, serializeDraft } from '../src/notebook-edit.js';

test('edits and reorders without reserializing unknown data, outputs, or large integers', () => {
  const raw = '\uFEFF{\r\n "nbformat":4,"cells":[\r\n' +
    ' {"id":"x","source":["first\\n","line"],"unknown":{"number":9007199254740995}},\r\n' +
    ' {"id":"x","source":"second","outputs":[ {"extra":"\\u2603"} ]}\r\n ],"extra":1e+03\r\n}\r\n';
  const set = draftCells(parseNotebook(raw));
  set[0].source = 'changed\r\nline\n';
  const saved = serializeDraft(raw, set.reverse());
  assert.match(saved, /^\uFEFF\{\r\n/);
  assert.match(saved, /"number":9007199254740995/);
  assert.match(saved, /"outputs":\[ \{"extra":"\\u2603"\} \]/);
  assert.match(saved, /"extra":1e\+03/);
  assert.deepEqual(parseNotebook(saved).cells.map((cell) => cell.source), ['second', ['changed\r\n', 'line\n']]);
});

test('projects imports before later uses and remaps diagnostics after reorder by cell identity', () => {
  const entries = draftCells({ cells: [
    { cell_type: 'code', source: 'import math as m' },
    { cell_type: 'markdown', source: 'm.fake' },
    { cell_type: 'code', source: '%time something\nm.sq' }
  ] });
  const projection = projectPython(entries);
  assert.equal(projection.text, 'import math as m\n\n' + ' '.repeat(15) + '\nm.sq\n\n');
  const [first,, last] = entries;
  const item = { line: 3, character: 2, message: 'suggest' };
  assert.deepEqual(mapDiagnostics(projection, [item]).get(last), [{ ...item, line: 1 }]);
  const reordered = projectPython(entries.reverse());
  assert.deepEqual(mapDiagnostics(reordered, [{ ...item, line: 1 }]).get(last), [{ ...item, line: 1 }]);
  assert.equal(reordered.ranges.at(-1).entry, first);
});

test('removes selected cells and clears saved output without reserializing surviving fields', () => {
  const raw = '{"nbformat":4, "cells":[ \n' +
    '{"source":"deleted"},\n' +
    '{"cell_type":"code", "source":"keep", "metadata":{"large":9007199254740995}, "outputs":[{"custom":42}], "execution_count":8},\n' +
    '{"source":"also deleted"}\n ], "extra":1e+03}';
  const [, cell] = draftCells(parseNotebook(raw));
  cell.source = 'updated';
  cell.execution = { outputs: [], count: null };
  const saved = serializeDraft(raw, [cell]);
  assert.match(saved, /"large":9007199254740995/);
  assert.match(saved, /"extra":1e\+03/);
  assert.deepEqual(parseNotebook(saved).cells, [{ cell_type: 'code', source: 'updated',
    metadata: { large: 9007199254740996 }, outputs: [], execution_count: null }]);
  assert.deepEqual(parseNotebook(serializeDraft(saved, [])).cells, []);
});

test('runs the requested range in document order and writes only the changed outputs', () => {
  const raw = '{"nbformat":4,"cells":[{"cell_type":"code","source":"x=3","outputs":[{"unknown":1}]},{"cell_type":"markdown","source":"skip"},{"cell_type":"code","source":"x+1","metadata":{"unknown":9007199254740995}},{"cell_type":"code","source":" "},{"cell_type":"code","source":"x+2"}]}';
  const entries = draftCells(parseNotebook(raw));
  const [first,, middle,, last] = entries;
  assert.deepEqual(executionBatch(entries, 'all'), [first, middle, last]);
  assert.deepEqual(executionBatch(entries, 'above', middle), [first]);
  assert.deepEqual(executionBatch(entries, 'below', middle), [middle, last]);
  assert.deepEqual(executionBatch(entries, 'one', middle), [middle]);
  middle.execution = { count: 2, outputs: [{ output_type: 'stream', name: 'stdout', text: '4' }] };
  const saved = serializeDraft(raw, entries);
  assert.match(saved, /9007199254740995/);
  const model = parseNotebook(saved);
  assert.deepEqual(model.cells[0].outputs, [{ unknown: 1 }]);
  assert.equal(model.cells[2].execution_count, 2);
  assert.deepEqual(model.cells[2].outputs, middle.execution.outputs);
});

test('retains unfamiliar data and the raw text, including invalid JSON', () => {
  const raw = '\uFEFF{\r\n  "nbformat": 4, "cells": [{"metadata":{"extra":{"word":"\u96EA"}}}], "vendor":{"big":9007199254740995}\r\n}\r\n';
  const model = parseNotebook(raw);
  assert.equal(model.raw, raw);
  assert.equal(model.cells[0].metadata.extra.word, '\u96EA');
  assert.equal(parseNotebook('{oops').error, 'invalidJson');
  assert.equal(parseNotebook('{"cells":[],"nbformat":3}').error, 'invalidNotebook');
  const long = 'a'.repeat(JSON_PAGE_SIZE - 1) + '\u{1F600}' + 'b'.repeat(JSON_PAGE_SIZE - 3) + '\r\nEND';
  const offsets = jsonPages(long);
  const pages = offsets.slice(1).map((end, i) => long.slice(offsets[i], end));
  assert.equal(pages.join(''), long);
  assert.equal(pages[1].slice(0, 2), '\u{1F600}');
  assert.equal(pages[2], '\r\nEND');
});

test('defaults notebooks without kernel metadata to Python', () => {
  const model = parseNotebook('{"nbformat":4,"cells":[{"cell_type":"code","source":"1+1"}]}');
  assert.equal(model.language, 'python');
});

test('search matches normalized source and saved text; ignores HTML and base64', () => {
  const cells = [
    { source: ['caf', 'e\u0301'], outputs: [{ data: { 'text/plain': 'AcCuRaCy 99%' } }] },
    { source: 'trace', outputs: [{ output_type: 'error', traceback: ['\x1b[31mRuntimeError\x1b[0m'] }] },
    { source: 'plot', outputs: [{ data: { 'text/html': '<b>accuracy</b>', 'image/png': 'accuracy' } }] }
  ];
  assert.deepEqual(searchCells(cells, ' caf\u00E9 '), [0]);
  assert.deepEqual(searchCells(cells, 'accuracy'), [0]);
  assert.deepEqual(searchCells(cells, 'runtimeerror'), [1]);
  assert.deepEqual(searchCells(cells, ''), [0, 1, 2]);
});

test('Markdown renders inline and block math; source HTML and links remain inert', () => {
  const source = ['# Sample', '$x^2$ and \\(a+b\\)', '', '$$', '\\frac{1}{2}', '$$', '',
    '`$not math`', '', '<script>bad()</script>', '',
    '![remote](https://example.test/image.png) [click](https://example.test/)',
    '', '$\\href{https://example.test/}{no}$'].join('\n');
  const rendered = markdownMarkup(source);
  assert.equal((rendered.match(/<math\b/g) || []).length, 3);
  assert.match(rendered, /<mfrac>/);
  assert.match(rendered, /<code>\$not math<\/code>/);
  assert.match(rendered, /&lt;script&gt;/);
  assert.doesNotMatch(rendered, /<(?:script|a|img)\b|\bhref="/i);
  assert.equal(embeddedImage('image/png', btoa('<svg onload="bad()">')), '');
  assert.equal(embeddedImage('image/svg+xml', btoa('<svg />')), '');
});

test('archive has the expected entries, matching hashes and equivalent locale placeholders', async () => {
  const base = new URL('../', import.meta.url);
  const template = JSON.parse(await readFile(new URL('manifest.json', base), 'utf8'));
  const archive = await readFile(new URL('artifacts/' + template.id + '-' + template.version + '.boboplugin', base));
  const entries = unzipSync(archive);
  const decode = new TextDecoder();
  const manifest = JSON.parse(decode.decode(entries['manifest.json']));
  assert.deepEqual(Object.keys(entries).sort(), [
    'manifest.json', manifest.main, ...manifest.contributes.documentViewers.flatMap((view) => [view.entry, ...view.resources]),
    ...new Set(Object.values(manifest.localization)), 'THIRD-PARTY.txt'
  ].sort());
  assert.deepEqual(manifest.permissions, ['documentViews.register', 'documents.read', 'documents.write', 'documents.analyze', 'documents.execute', 'sourceControl.register']);
  assert.deepEqual(Object.keys(manifest.integrity.files).sort(), Object.keys(entries).filter((file) => file !== 'manifest.json').sort());
  for (const [name, digest] of Object.entries(manifest.integrity.files)) {
    assert.equal(createHash('sha256').update(entries[name]).digest('hex'), digest);
  }
  const english = JSON.parse(decode.decode(entries[manifest.localization.en]));
  for (const locale of ['zh-CN', 'ja']) {
    const messages = JSON.parse(decode.decode(entries[manifest.localization[locale]]));
    assert.deepEqual(Object.keys(messages).sort(), Object.keys(english).sort());
    for (const [key, value] of Object.entries(messages)) {
      assert.ok(value.trim().length > 0, locale + ': ' + key);
      assert.deepEqual(value.match(/\{\w+\}/g)?.sort(), english[key].match(/\{\w+\}/g)?.sort(), locale + ': ' + key);
    }
  }
});
