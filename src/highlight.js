import hljs from 'highlight.js/lib/core';
import python from 'highlight.js/lib/languages/python';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import julia from 'highlight.js/lib/languages/julia';
import r from 'highlight.js/lib/languages/r';
import bash from 'highlight.js/lib/languages/bash';
import sql from 'highlight.js/lib/languages/sql';
import { isPython } from './notebook-edit.js';

export const MAX_HIGHLIGHT_LENGTH = 48_000;

for (const [name, grammar] of Object.entries({ python, javascript, typescript, julia, r, bash, sql })) {
  hljs.registerLanguage(name, grammar);
}

// Capture the grammar vocabulary before highlight.js compiles it in place.
const pythonKeywords = hljs.getLanguage('python').keywords;
const pythonNames = ['keyword', 'built_in', 'literal'].flatMap((kind) =>
  pythonKeywords[kind].map((word) => word.split('|', 1)[0]));

export const pythonCompletions = (prefix) => pythonNames
  .filter((name) => name !== prefix && name.startsWith(prefix))
  .map((name) => ({ label: name, insertText: name }));

export function highlightCode(element, source, language) {
  const key = isPython(language) ? 'python' : language.toLowerCase();
  element.textContent = source;
  if (source.length > MAX_HIGHLIGHT_LENGTH || !hljs.getLanguage(key)) return;
  // highlight.js escapes the input and emits only bundled token markup.
  element.innerHTML = hljs.highlight(source, { language: key, ignoreIllegals: true }).value;
}
