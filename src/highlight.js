import hljs from 'highlight.js/lib/core';
import python from 'highlight.js/lib/languages/python';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import julia from 'highlight.js/lib/languages/julia';
import r from 'highlight.js/lib/languages/r';
import bash from 'highlight.js/lib/languages/bash';
import sql from 'highlight.js/lib/languages/sql';
import { isPython } from './notebook-edit.js';

for (const [name, grammar] of Object.entries({ python, javascript, typescript, julia, r, bash, sql })) {
  hljs.registerLanguage(name, grammar);
}

export function highlightCode(element, source, language) {
  const key = isPython(language) ? 'python' : language.toLowerCase();
  element.textContent = source;
  if (source.length > 48_000 || !hljs.getLanguage(key)) return;
  // highlight.js escapes the input and emits only bundled token markup.
  element.innerHTML = hljs.highlight(source, { language: key, ignoreIllegals: true }).value;
}
