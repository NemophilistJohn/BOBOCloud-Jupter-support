import MarkdownIt from 'markdown-it';
import { tex } from '@mdit/plugin-tex';
import DOMPurify from 'dompurify';
import temml from 'temml';
import { embeddedImage, imageMimes, isObject, MAX_RICH_TEXT, textOf } from './notebook-model.js';

const markdown = new MarkdownIt({ html: false, linkify: false, maxNesting: 16 });
const escape = markdown.utils.escapeHtml;

export function mathMarkup(source, displayMode) {
  const fallback = '<code>' + escape(source.slice(0, 1500)) + '</code>';
  if (source.length > 1500) return fallback;
  try {
    return temml.renderToString(source, {
      displayMode, trust: false, throwOnError: true, strict: true, maxExpand: 128, maxSize: [20, 20]
    });
  } catch {
    return fallback;
  }
}

markdown.use(tex, {
  delimiters: 'all', mathFence: true,
  render: (source, display, env) => env.mathBudget-- > 0
    ? mathMarkup(source, display) : '<code>' + escape(source) + '</code>'
});
markdown.renderer.rules.link_open = () => '<span class="inert-link">';
markdown.renderer.rules.link_close = () => '</span>';
markdown.renderer.rules.image = (tokens, index, _options, env, renderer) => {
  const token = tokens[index];
  const alt = renderer.renderInlineAsText(token.children, {}, env);
  const src = token.attrGet('src') || '';
  const name = src.startsWith('attachment:') && src.slice('attachment:'.length);
  let data = null;
  try { if (name && isObject(env.attachments)) data = env.attachments[decodeURIComponent(name)]; } catch { /* invalid URI */ }
  const url = data && imageMimes.map((mime) => embeddedImage(mime, data[mime])).find(Boolean);
  return url ? '<img loading="lazy" decoding="async" alt="' + escape(alt) + '" src="' + url + '">'
    : '<span class="inert-link">' + escape(alt) + '</span>';
};

export function markdownMarkup(source, attachments) {
  return markdown.render(source.slice(0, MAX_RICH_TEXT), { attachments, mathBudget: 32 });
}

// Keep static formatting and tables, with no attributes, URLs, or active elements.
export function staticOutput(source) {
  return DOMPurify.sanitize(textOf(source).slice(0, MAX_RICH_TEXT), {
    ALLOWED_TAGS: ['p', 'div', 'span', 'br', 'b', 'strong', 'i', 'em', 'small', 'sub', 'sup',
      'h1', 'h2', 'h3', 'h4', 'pre', 'code', 'blockquote', 'ul', 'ol', 'li', 'table', 'caption',
      'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'hr'],
    ALLOWED_ATTR: [], ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: false, RETURN_DOM_FRAGMENT: true
  });
}
