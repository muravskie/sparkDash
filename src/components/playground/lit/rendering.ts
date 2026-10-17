import MarkdownIt from 'markdown-it';
import DOMPurify from 'dompurify';

const markdown = new MarkdownIt({html: false, breaks: true, linkify: false});
const escape = markdown.utils.escapeHtml;
markdown.renderer.rules.link_open = (tokens, index, options, _env, renderer) => {
  tokens[index].attrSet('target', '_blank');
  tokens[index].attrSet('rel', 'noopener noreferrer');
  tokens[index].attrSet('referrerpolicy', 'no-referrer');
  return renderer.renderToken(tokens, index, options);
};
markdown.renderer.rules.image = (tokens, index) => {
  const token = tokens[index], source = String(token.attrGet('src') || '');
  const label = token.content || 'Open image';
  if (/^data:image\/(png|gif|jpeg|webp);/i.test(source)) return '<img src="' + escape(source) + '" alt="' + escape(label) + '">';
  // Remote images are explicit links rather than automatic browser requests.
  return '<a class="markdown-image" href="' + escape(source) + '" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">Image: ' + escape(label) + '</a>';
};

export function parseAnswer(source: string): {markdown: string; documents: string[]} {
  const tokens = markdown.parse(source, {});
  const documents = tokens.filter(t => t.type === 'fence' && /^(html|htm)(?:\s|$)/i.test(t.info.trim())).map(t => t.content).filter(t => t.trim());
  if (!documents.length) {
    const raw = source.trim();
    const complete = /(?:<!doctype\s+html\b[^>]*>\s*)?<html(?:\s[^>]*|)>[\s\S]*?<\/html\s*>/i.exec(raw);
    if (complete) documents.push(complete[0]);
    else if (/^(?:<!doctype\s+html\b|<[a-z][\w-]*(?:\s|>|\/))/i.test(raw)) documents.push(raw);
  }
  return {markdown: markdown.renderer.render(tokens, markdown.options, {}), documents: documents.slice(0, 8)};
}

export function sanitizeMarkdown(markup: string): string {
  return DOMPurify.sanitize(markup, {
    ALLOWED_TAGS: ['p', 'a', 'em', 'strong', 's', 'blockquote', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'pre', 'code', 'hr', 'br', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'img'],
    ALLOWED_ATTR: ['href', 'src', 'alt', 'title', 'class', 'start', 'style', 'target', 'rel', 'referrerpolicy'],
  });
}
