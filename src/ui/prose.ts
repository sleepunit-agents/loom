/**
 * Markdown as HTML, for the `prose` block: what knowledge pages and memories
 * are written in. markdown-it with raw HTML off, so HTML in a body is shown
 * as text, never run; links only to http(s), opening outside the page;
 * headings drawn two levels down (the page owns h1 and h2); no images (a
 * body can't make the page fetch anything).
 */
import MarkdownIt from 'markdown-it';

const md = new MarkdownIt({ html: false, linkify: false, typographer: false, breaks: true });
md.disable('image');
md.validateLink = (url: string) => /^https?:\/\//i.test(url.trim());

const shift = (tag: string) => `h${Math.min(6, Number(tag.slice(1)) + 2)}`;
md.renderer.rules.heading_open = (tokens, i, opts, _env, self) => { tokens[i].tag = shift(tokens[i].tag); return self.renderToken(tokens, i, opts); };
md.renderer.rules.heading_close = (tokens, i, opts, _env, self) => { tokens[i].tag = shift(tokens[i].tag); return self.renderToken(tokens, i, opts); };
md.renderer.rules.link_open = (tokens, i, opts, _env, self) => {
  tokens[i].attrSet('rel', 'noopener noreferrer');
  tokens[i].attrSet('target', '_blank');
  return self.renderToken(tokens, i, opts);
};

export function prose(src: string): string {
  return md.render(src);
}
