import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { unzipSync } from 'fflate';
import { embeddedImage, jsonPages, JSON_PAGE_SIZE, parseNotebook, searchCells } from '../src/notebook-model.js';
import { markdownMarkup } from '../src/rich-content.js';

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
  assert.deepEqual(manifest.permissions, ['documentViews.register', 'documents.read', 'sourceControl.register']);
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
