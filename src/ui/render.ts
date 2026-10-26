/**
 * Server-side HTML for loom's page. Every string that reaches the page goes
 * through esc(): pieces send data in the page vocabulary, never markup. No
 * client script anywhere; folding is <details>, filters are links, and every
 * action is a plain form post carrying the anti-forgery token.
 */
import type { Ask, Block, Cell, Field, Page, Section, Tile, Tone } from './vocab.js';
import { splitPage } from './vocab.js';

export function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Whose page this is: loom's own (`loom`) or a piece's. `base` is where its
 * page links resolve; `act` is where its forms post (one agent's view in a
 * household posts to that agent).
 */
export interface Source { id: string; base: string; act?: string }

export const CORE: Source = { id: 'loom', base: '/' };
export const pieceSource = (piece: string): Source => ({ id: piece, base: `/p/${piece}/` });
/** One agent's view in a household. */
export const agentSource = (agent: string): Source => ({ id: 'loom', base: `/a/${agent}/`, act: `/a/${agent}/act/loom` });

export interface RenderContext {
  source: Source;
  /** This page's path within its source, and its query, for filters and for returning after an action. */
  path: string;
  query: Record<string, string>;
  csrf: string;
}

function qs(query: Record<string, string>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== '') p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : '';
}

/** Where a page link goes. Pieces' links stay inside their own base unless they say `loom:`. */
export function pageHref(link: string, source: Source): string {
  const s = splitPage(link);
  if (!s) return '#';
  const base = s.core ? CORE.base : source.base;
  const url = s.path === '' ? (base === CORE.base ? '/' : base.replace(/\/$/, '')) : base + s.path;
  return url + qs(s.query);
}

const tone = (t?: Tone) => (t ? ` tone-${t}` : '');

function link(text: string, t: { page?: string; href?: string }, ctx: RenderContext, cls = ''): string {
  const c = cls ? ` class="${cls}"` : '';
  if (t.href) return `<a${c} href="${esc(t.href)}" rel="noopener noreferrer" target="_blank">${text}</a>`;
  if (t.page !== undefined) return `<a${c} href="${esc(pageHref(t.page, ctx.source))}">${text}</a>`;
  return text;
}

function hiddenInputs(fields: Record<string, string>): string {
  return Object.entries(fields).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('');
}

function actionForm(ctx: RenderContext, action: string, inner: string, cls: string): string {
  const back = ctx.path + qs(ctx.query);
  return `<form class="${cls}" method="post" action="${esc(ctx.source.act ?? `/act/${ctx.source.id}`)}">${hiddenInputs({ _csrf: ctx.csrf, _action: action, _path: back })}${inner}</form>`;
}

let fieldSeq = 0;

function renderField(f: Field): string {
  const id = `f${++fieldSeq}-${f.name}`;
  const req = f.required ? ' required' : '';
  const hint = f.hint ? `<span class="hint" id="${id}-h">${esc(f.hint)}</span>` : '';
  const desc = f.hint ? ` aria-describedby="${id}-h"` : '';
  switch (f.kind) {
    case 'text':
      return `<div class="field"><label for="${id}">${esc(f.label)}</label><input id="${id}" name="${esc(f.name)}" type="text" value="${esc(f.value ?? '')}" autocomplete="off" spellcheck="false"${req}${desc}>${hint}</div>`;
    case 'secret':
      // Never prefilled. Asks the browser and the common password managers
      // not to offer to save it (or to fill it with loom's own token); no
      // browser promises to honour that, which the contract says.
      return `<div class="field"><label for="${id}">${esc(f.label)}</label><input id="${id}" name="${esc(f.name)}" type="password" autocomplete="off" data-1p-ignore data-lpignore="true" data-bwignore="true" data-form-type="other" spellcheck="false"${req}${desc}>${hint}</div>`;
    case 'textarea':
      return `<div class="field"><label for="${id}">${esc(f.label)}</label><textarea id="${id}" name="${esc(f.name)}" rows="4"${req}${desc}>${esc(f.value ?? '')}</textarea>${hint}</div>`;
    case 'choice':
      return `<fieldset class="field choice"><legend>${esc(f.label)}</legend>${(f.options ?? []).map((o, i) =>
        `<label class="option"><input type="radio" name="${esc(f.name)}" value="${esc(o.value)}"${f.value === o.value ? ' checked' : ''}${req && i === 0 ? ' required' : ''}><span><strong>${esc(o.label)}</strong>${o.detail ? `<span class="hint">${esc(o.detail)}</span>` : ''}</span></label>`).join('')}${hint}</fieldset>`;
  }
}

function cell(c: Cell, ctx: RenderContext): string {
  if (typeof c === 'string') return esc(c);
  return c.page !== undefined ? link(esc(c.text), { page: c.page }, ctx) : esc(c.text);
}

function renderBlock(b: Block, ctx: RenderContext): string {
  switch (b.type) {
    case 'stats':
      return `<dl class="stats">${b.items.map((i) => {
        const inner = `<dt>${esc(i.label)}</dt><dd>${esc(i.value)}</dd>${i.detail ? `<dd class="detail">${esc(i.detail)}</dd>` : ''}`;
        return i.page !== undefined
          ? `<div class="stat${tone(i.tone)}"><a class="stat-link" href="${esc(pageHref(i.page, ctx.source))}">${inner}</a></div>`
          : `<div class="stat${tone(i.tone)}">${inner}</div>`;
      }).join('')}</dl>`;
    case 'list':
      return `<ul class="list">${b.items.map((i) => {
        const text = `<span class="text">${esc(i.text)}</span>`;
        return `<li class="${tone(i.tone).trim()}"><div class="row">${link(text, i, ctx, 'row-link')}${i.badge ? `<span class="badge">${esc(i.badge)}</span>` : ''}</div>${
          i.meta ? `<span class="meta">${esc(i.meta)}</span>` : ''}</li>`;
      }).join('')}</ul>`;
    case 'table':
      return `<div class="table-wrap"><table><thead><tr>${b.columns.map((c) => `<th scope="col">${esc(c)}</th>`).join('')}</tr></thead><tbody>${
        b.rows.map((r) => `<tr>${r.map((c) => `<td>${cell(c, ctx)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
    case 'kv':
      return `<dl class="kv">${b.items.map((i) =>
        `<div><dt>${esc(i.label)}</dt><dd>${i.page !== undefined ? link(esc(i.value), { page: i.page }, ctx) : esc(i.value)}</dd></div>`).join('')}</dl>`;
    case 'text':
      return `<p class="text-block${tone(b.tone)}">${esc(b.text)}</p>`;
    case 'callout':
      return `<div class="callout${tone(b.tone)}">${b.title ? `<strong>${esc(b.title)}</strong>` : ''}<p>${esc(b.text)}</p></div>`;
    case 'link':
      return `<p class="link-block">${link(esc(b.text), b, ctx)}</p>`;
    case 'filters': {
      const current = ctx.query[b.param] ?? '';
      return `<nav class="filters" aria-label="Filter">${b.options.map((o) => {
        const href = pageHref(ctx.path, ctx.source);
        const target = href + qs({ ...ctx.query, [b.param]: o.value });
        const on = o.value === current;
        return `<a class="pill${on ? ' on' : ''}" href="${esc(target)}"${on ? ' aria-current="true"' : ''}>${esc(o.label)}</a>`;
      }).join('')}</nav>`;
    }
    case 'details':
      return `<details class="details"><summary><span class="text">${esc(b.summary)}</span>${b.meta ? `<span class="meta">${esc(b.meta)}</span>` : ''}</summary><div class="details-body">${
        b.blocks.map((x) => renderBlock(x, ctx)).join('')}</div></details>`;
    case 'form':
      return actionForm(
        ctx,
        b.action,
        `${b.title ? `<h3>${esc(b.title)}</h3>` : ''}${hiddenInputs(b.hidden ?? {})}${b.fields.map(renderField).join('')}${
          b.note ? `<p class="note">${esc(b.note)}</p>` : ''}<div class="actions"><button class="btn primary" type="submit">${esc(b.submit)}</button></div>`,
        'piece-form',
      );
    case 'buttons':
      return `<div class="buttons">${b.items.map((i) => actionForm(
        ctx,
        i.action,
        `${hiddenInputs(i.fields ?? {})}<button class="btn${i.tone ? ` ${i.tone}` : ''}" type="submit">${esc(i.label)}</button>`,
        'button-form',
      )).join('')}</div>`;
  }
}

// Ids are namespaced (s-<source>--<id>) so no piece's anchors can land on another's or on loom's.
function renderSection(s: Section, ctx: RenderContext, headingLevel = 2): string {
  const h = s.title ? `<h${headingLevel}>${esc(s.title)}</h${headingLevel}>` : '';
  return `<section class="card${tone(s.tone)}" id="s-${esc(ctx.source.id)}--${esc(s.id)}">${h}${s.blocks.map((b) => renderBlock(b, ctx)).join('')}</section>`;
}

function columns(main: string, side: string): string {
  return side ? `<div class="cols"><div class="main-col">${main}</div><aside class="side-col">${side}</aside></div>` : `<div class="main-col solo">${main}</div>`;
}

export interface Chrome {
  agent: string;
  nav: Array<{ label: string; href: string; current: boolean; piece: boolean }>;
  clock: string;
  csrf: string;
  /** The one-time result of an action; `from` names the piece that sent it. */
  flash?: { ok: boolean; message: string; from?: string };
  skipped: string[];
}

const STYLE = `
:root{--bg:#f4f5f7;--card:#fff;--fg:#15171c;--muted:#596171;--line:#e1e4ea;--soft:#eef0f3;--accent:#3442c2;--accent-fg:#fff;--ok:#1d6b45;--ok-bg:#e7f4ec;--warn:#8a4b0a;--warn-line:#e9c98f;--warn-bg:#fffbf3;--bad:#b42318;--bad-line:#f1c4bf;--bad-bg:#fff7f6;--pill:#15171c;--pill-fg:#fff;color-scheme:light}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#121317;--card:#1b1d23;--fg:#e9ebf0;--muted:#a0a7b4;--line:#2c3039;--soft:#23262e;--accent:#9aa6ff;--accent-fg:#121317;--ok:#6fd39b;--ok-bg:#16291f;--warn:#f0b35c;--warn-line:#5a4520;--warn-bg:#231d12;--bad:#ff8f84;--bad-line:#5c2a25;--bad-bg:#2a1714;--pill:#e9ebf0;--pill-fg:#121317;color-scheme:dark}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
.mono,.meta,.badge,.eyebrow,.kv dt,.stat dt,code{font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
header.top{background:var(--card);border-bottom:1px solid var(--line)}
.top-in{max-width:1200px;margin:0 auto;padding:0 16px;display:flex;flex-wrap:wrap;align-items:center;gap:4px 24px}
.brand{display:flex;align-items:center;gap:8px;color:var(--fg);padding:12px 0;font-weight:600}.brand:hover{text-decoration:none}.brand .who{color:var(--muted);font-weight:400}
nav.tabs{display:flex;flex-wrap:wrap;gap:0 18px;flex:1 1 auto;align-items:center}
nav.tabs a{color:var(--muted);padding:12px 2px;border-bottom:2px solid transparent;font-size:14px}nav.tabs a:hover{color:var(--fg);text-decoration:none}
nav.tabs a[aria-current]{color:var(--fg);border-bottom-color:var(--accent);font-weight:500}
nav.tabs .sep{width:1px;height:18px;background:var(--line)}
.top-right{display:flex;align-items:center;gap:12px;font-size:13px;color:var(--muted)}
main{max-width:1200px;margin:0 auto;padding:24px 16px 48px;display:flex;flex-direction:column;gap:18px}
h1{margin:0;font-size:26px;font-weight:600;letter-spacing:-.01em;line-height:1.25}
.intro{margin:4px 0 0;color:var(--muted);max-width:720px}
.flash{padding:12px 16px;border-radius:10px;border:1px solid var(--line);background:var(--card)}.flash.ok{border-color:var(--ok);background:var(--ok-bg);color:var(--ok)}.flash.bad{border-color:var(--bad-line);background:var(--bad-bg);color:var(--bad)}
.cols{display:flex;flex-wrap:wrap;gap:20px;align-items:flex-start}.main-col{flex:999 1 560px;min-width:0;display:flex;flex-direction:column;gap:16px}.side-col{flex:1 1 300px;min-width:0;display:flex;flex-direction:column;gap:16px}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px}
.tile{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px;color:var(--fg);display:flex;flex-direction:column;gap:2px}a.tile:hover{text-decoration:none;border-color:var(--muted)}
.tile .eyebrow{font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}.tile .value{font-size:20px;font-weight:600}.tile .detail{font-size:13px;color:var(--muted)}
.tile.tone-ok .detail{color:var(--ok)}.tile.tone-warn .detail{color:var(--warn)}.tile.tone-bad .detail{color:var(--bad)}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px 18px;min-width:0}
.card h2{margin:0 0 8px;font-size:16px;font-weight:600}.card h3{margin:0 0 8px;font-size:15px}
.card.tone-warn{border-color:var(--warn-line);background:var(--warn-bg)}.card.tone-bad{border-color:var(--bad-line);background:var(--bad-bg)}.card.tone-ok{border-color:var(--ok);background:var(--ok-bg)}
.card>*+*{margin-top:10px}
.stats{display:flex;flex-wrap:wrap;gap:12px 28px;margin:0}.stat dt{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.05em}.stat dd{margin:0;font-size:22px;font-weight:600;font-variant-numeric:tabular-nums}.stat dd.detail,.stat.tone-ok dd.detail,.stat.tone-warn dd.detail,.stat.tone-bad dd.detail{font-size:13px;font-weight:400;color:var(--muted)}
.stat-link{color:inherit;display:block}.stat-link:hover{text-decoration:none}.stat-link:hover dd:first-of-type{color:var(--accent)}
.stat.tone-ok>dd,.stat.tone-ok a>dd,.list li.tone-ok .text{color:var(--ok)}.stat.tone-warn>dd,.stat.tone-warn a>dd,.list li.tone-warn .text{color:var(--warn)}.stat.tone-bad>dd,.stat.tone-bad a>dd,.list li.tone-bad .text{color:var(--bad)}.stat.tone-muted>dd,.stat.tone-muted a>dd,.list li.tone-muted .text{color:var(--muted)}
.ask .text{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.list{list-style:none;margin:0;padding:0}.list li{padding:9px 0;border-top:1px solid var(--soft);display:flex;flex-direction:column;gap:2px}.list li:first-child{border-top:0}
.list .row{display:flex;align-items:baseline;gap:10px}.list .row-link{color:inherit;flex:1;min-width:0}.list .row-link:hover{color:var(--accent);text-decoration:none}
.list .text{overflow-wrap:anywhere}.meta{color:var(--muted);font-size:12px}
.badge{font-size:11px;color:var(--warn);background:var(--warn-bg);border:1px solid var(--warn-line);border-radius:4px;padding:1px 6px;white-space:nowrap}
.text-block{margin:0;white-space:pre-line;overflow-wrap:anywhere}.text-block.tone-muted{color:var(--muted);font-size:13px}.text-block.tone-warn{color:var(--warn)}.text-block.tone-bad{color:var(--bad)}.text-block.tone-ok{color:var(--ok)}
.callout{padding:12px 14px;border-radius:8px;background:var(--soft)}.callout p{margin:2px 0 0}.callout.tone-warn{background:var(--warn-bg);border:1px solid var(--warn-line)}.callout.tone-bad{background:var(--bad-bg);border:1px solid var(--bad-line);color:var(--bad)}.callout.tone-ok{background:var(--ok-bg);color:var(--ok)}
.link-block{margin:0;font-size:14px}
.kv{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:10px 18px;margin:0}.kv dt{color:var(--muted);font-size:12px}.kv dd{margin:2px 0 0;overflow-wrap:anywhere;font-size:14px}
.side-col .kv{grid-template-columns:1fr 1fr}
.table-wrap{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:14px}th,td{text-align:left;padding:8px 10px 8px 0;border-top:1px solid var(--soft);vertical-align:top}th{color:var(--muted);font-weight:500;font-size:12px;text-transform:uppercase;letter-spacing:.05em;border-top:0}
.filters{display:flex;flex-wrap:wrap;gap:8px}.pill{font-size:13px;min-height:32px;display:inline-flex;align-items:center;padding:0 12px;border-radius:16px;border:1px solid var(--line);background:var(--card);color:var(--fg)}.pill:hover{text-decoration:none;border-color:var(--muted)}.pill.on{background:var(--pill);border-color:var(--pill);color:var(--pill-fg)}
details.details{border-top:1px solid var(--soft)}details.details:first-of-type{border-top:0}
details.details>summary{cursor:pointer;padding:10px 0;display:flex;flex-direction:column;gap:2px;list-style:none}details.details>summary::-webkit-details-marker{display:none}
details.details>summary .text::before{content:"▸ ";color:var(--muted)}details.details[open]>summary .text::before{content:"▾ "}
.details-body{margin:0 0 12px 14px;padding:12px 14px;border-radius:8px;background:var(--soft);display:flex;flex-direction:column;gap:10px}
.btn{font:inherit;font-size:14px;font-weight:500;min-height:36px;padding:0 14px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--fg);cursor:pointer}.btn:hover{border-color:var(--muted)}
.btn.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-fg)}.btn.danger{color:var(--bad)}
.buttons{display:flex;flex-wrap:wrap;gap:8px}.button-form{margin:0}
.piece-form{display:flex;flex-direction:column;gap:14px;margin:0}.field{display:flex;flex-direction:column;gap:5px;border:0;padding:0;margin:0}.field label,.field legend{font-size:14px;font-weight:500}
.field input[type=text],.field input[type=password],.field textarea{font:inherit;font-size:15px;min-height:44px;padding:8px 12px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--fg);width:100%}
.field input:focus,.field textarea:focus{outline:2px solid var(--accent);outline-offset:1px}
.hint{font-size:12px;color:var(--muted)}.note{margin:0;font-size:13px;color:var(--muted)}.actions{display:flex;gap:10px}
.choice .option{display:flex;gap:10px;align-items:flex-start;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:var(--card);margin-top:6px;cursor:pointer}.choice .option span{display:flex;flex-direction:column;gap:2px}
footer{max-width:1200px;margin:0 auto;padding:0 16px 32px;color:var(--muted);font-size:12px;display:flex;flex-wrap:wrap;gap:6px 14px}
form.inline{display:inline;margin:0}form.inline button{background:none;border:1px solid var(--line);border-radius:6px;padding:4px 10px;color:var(--fg);font:inherit;font-size:13px;cursor:pointer}
form.login{max-width:380px;margin:64px auto;padding:20px;display:flex;flex-direction:column;gap:10px}form.login input{width:100%;min-height:44px;padding:8px 12px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--fg);font:inherit}
form.login button{min-height:44px;border:0;border-radius:8px;background:var(--accent);color:var(--accent-fg);font:inherit;font-weight:500}.err{color:var(--bad)}.sub{color:var(--muted);margin:0}
`;

function document(title: string, body: string, refresh: boolean): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${
    refresh ? '<meta http-equiv="refresh" content="60">' : ''}<title>${esc(title)}</title><style>${STYLE}</style></head><body>${body}</body></html>`;
}

function chromeTop(c: Chrome): string {
  const core = c.nav.filter((n) => !n.piece);
  const pieces = c.nav.filter((n) => n.piece);
  const tab = (n: Chrome['nav'][number]) => `<a href="${esc(n.href)}"${n.current ? ' aria-current="page"' : ''}>${esc(n.label)}</a>`;
  return `<header class="top"><div class="top-in"><a class="brand" href="/"><svg width="20" height="20" viewBox="0 0 22 22" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M3 5h16M3 11h16M3 17h16"></path><path d="M7 2v18M15 2v18" opacity=".55"></path></svg>loom <span class="who">· ${esc(c.agent)}</span></a>` +
    `<nav class="tabs" aria-label="Sections">${core.map(tab).join('')}${pieces.length ? `<span class="sep" aria-hidden="true"></span>${pieces.map(tab).join('')}` : ''}</nav>` +
    `<div class="top-right"><span class="mono">${esc(c.clock)}</span><a class="mono" href="/passkeys">Passkeys</a><form class="inline" method="post" action="/logout"><input type="hidden" name="_csrf" value="${esc(c.csrf)}"><button type="submit">Sign out</button></form></div></div></header>`;
}

function chromeFoot(c: Chrome, refresh: boolean): string {
  return `<footer>${refresh ? '<span>Refreshes every minute.</span>' : ''}${c.skipped.length ? `<span>Pieces with no page: ${c.skipped.map(esc).join(', ')}</span>` : ''}</footer>`;
}

function flash(c: Chrome): string {
  if (!c.flash) return '';
  const from = c.flash.from ? `<strong>${esc(c.flash.from)}</strong> · ` : '';
  return `<div class="flash ${c.flash.ok ? 'ok' : 'bad'}" role="status">${from}${esc(c.flash.message)}</div>`;
}

/** One page, loom's or a piece's. */
export function renderPage(page: Page, ctx: RenderContext, chrome: Chrome): string {
  const main = page.sections.filter((s) => !s.side).map((s) => renderSection(s, ctx)).join('');
  const side = page.sections.filter((s) => s.side).map((s) => renderSection(s, ctx)).join('');
  const empty = page.sections.length ? '' : '<p class="intro">There\'s nothing here.</p>';
  // Pages with forms don't auto-refresh: a refresh would throw away what's being typed.
  const hasForm = page.sections.some((s) => s.blocks.some((b) => b.type === 'form' || (b.type === 'details' && b.blocks.some((x) => x.type === 'form'))));
  const body = `${chromeTop(chrome)}<main>${flash(chrome)}<div><h1>${esc(page.title)}</h1>${page.intro ? `<p class="intro">${esc(page.intro)}</p>` : ''}</div>${empty}${columns(main, side)}</main>${chromeFoot(chrome, !hasForm)}`;
  return document(`${page.title} · ${chrome.agent}`, body, !hasForm);
}

/** "Your call" shows this many a piece on Home; the rest are a link away. */
const ASKS_SHOWN = 5;

export interface HomeTile extends Tile { source: Source }
export interface HomeAsk extends Ask { source: Source }

/** Home: tiles across the top, the tape as the page, "Your call" leading the side column. */
export function renderHome(page: Page, ctx: RenderContext, chrome: Chrome, tiles: HomeTile[], asks: HomeAsk[]): string {
  const tileHtml = tiles.length
    ? `<section class="tiles" aria-label="Status">${tiles.map((t) => {
        const inner = `<span class="eyebrow">${esc(t.label)}</span><span class="value">${esc(t.value)}</span>${t.detail ? `<span class="detail">${esc(t.detail)}</span>` : ''}`;
        return t.page !== undefined
          ? `<a class="tile${tone(t.tone)}" href="${esc(pageHref(t.page, t.source))}">${inner}</a>`
          : `<div class="tile${tone(t.tone)}">${inner}</div>`;
      }).join('')}</section>`
    : '';
  const bySource = new Map<string, HomeAsk[]>();
  for (const a of asks) bySource.set(a.source.id, [...(bySource.get(a.source.id) ?? []), a]);
  const askItems = [...bySource.values()].flatMap((list) => {
    const shown = list.slice(0, ASKS_SHOWN).map((a) => {
      const go = a.page !== undefined ? `<a href="${esc(pageHref(a.page, a.source))}">${esc(a.label ?? 'Open')}</a>` : '';
      return `<li class="ask"><span class="text">${esc(a.text)}</span><div class="row"><span class="meta" style="flex:1">${esc(a.meta ?? a.source.id)}</span>${go}</div></li>`;
    });
    const rest = list.length - ASKS_SHOWN;
    if (rest > 0) shown.push(`<li><a href="${esc(pageHref('', list[0].source))}">${rest} more from ${esc(list[0].source.id)}</a></li>`);
    return shown;
  });
  const yours = askItems.length ? `<section class="card tone-warn" id="your-call"><h2>Your call</h2><ul class="list">${askItems.join('')}</ul></section>` : '';
  const main = page.sections.filter((s) => !s.side).map((s) => renderSection(s, ctx)).join('');
  const side = yours + page.sections.filter((s) => s.side).map((s) => renderSection(s, ctx)).join('');
  const body = `${chromeTop(chrome)}<main>${flash(chrome)}${tileHtml}${columns(main, side)}</main>${chromeFoot(chrome, true)}`;
  return document(chrome.agent, body, true);
}

/** A one-time sign-in link's page: a button, so a link preview can't spend it. */
export function renderLoginLink(code: string, error?: string): string {
  return document(
    'loom',
    error
      ? `<div class="login"><h1>loom</h1><p class="err">${esc(error)}</p><p class="sub">Ask for a new link (<code>loom token link</code>), or <a href="/login">sign in with a token</a>.</p></div>`
      : `<form class="login" method="post" action="/login/${esc(code)}"><h1>loom</h1><p class="sub">This link signs this browser in, once. It keeps a cookie for 30 days.</p><button type="submit">Sign in</button></form>`,
    false,
  );
}

export function renderLogin(error?: string, passkey: { rp?: string; here: boolean } = { here: false }): string {
  // A passkey button only where passkeys work (LOOM_PUBLIC_URL's origin); the script is loom's one (/login/passkey.js).
  const pk = passkey.here
    ? `<button type="button" id="passkey-signin">Sign in with a passkey</button><p class="sub" id="passkey-msg"></p><p class="sub">or paste the token:</p>`
    : passkey.rp ? `<p class="sub">Passkeys work at <a href="${esc(passkey.rp)}/login">${esc(passkey.rp)}</a>.</p>` : '';
  return document(
    'loom',
    `<form class="login" method="post" action="/login"><h1>loom</h1><p class="sub">Sign in with a passkey, paste the bearer token once, or open a sign-in link from <code>loom token link</code>. This browser keeps a cookie for 30 days.</p>${
      error ? `<p class="err">${esc(error)}</p>` : ''}${pk}<input type="password" name="token" autocomplete="current-password" ${passkey.here ? '' : 'autofocus '}aria-label="token"><button type="submit">Open</button></form>${
      passkey.here ? '<script src="/login/passkey.js" defer></script>' : ''}`,
    false,
  );
}

/**
 * The Passkeys page: an ordinary page, plus loom's own "add a passkey" control
 * and its script (/login/passkey.js) where passkeys work, or a note where they don't.
 */
export function renderPasskeys(page: Page, ctx: RenderContext, chrome: Chrome, add: { csrf: string } | { note: string }): string {
  const control = 'csrf' in add
    ? `<section class="card"><h2>Add a passkey</h2><form class="login" style="margin:0;padding:0;max-width:420px" action="/passkeys" method="get"><p class="sub">Name it so you'll know it later, like "Jonathan's phone".</p><input id="passkey-label" maxlength="60" placeholder="Name" aria-label="name"><button type="button" id="passkey-add" data-csrf="${esc(add.csrf)}">Add a passkey</button><p class="sub" id="passkey-msg"></p></form></section>`
    : `<section class="card"><h2>Add a passkey</h2><p class="sub">${esc(add.note)}</p></section>`;
  return renderPage(page, ctx, chrome)
    // No minute refresh here: it would cut off a passkey being made.
    .replace('<meta http-equiv="refresh" content="60">', '')
    .replace('<span>Refreshes every minute.</span>', '')
    // The control goes first, under the title: on a phone it's what the page is for.
    .replace(/(<main>[\s\S]*?<h1>[\s\S]*?<\/div>)/, `$1${control}`)
    .replace('</body>', `${'csrf' in add ? '<script src="/login/passkey.js" defer></script>' : ''}</body>`);
}
