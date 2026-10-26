/**
 * Server-side HTML for loom's page. Every string that reaches the page goes
 * through esc(): pieces send data in the page vocabulary, never markup. The
 * only script is loom's own (/app.js); folding is <details>, filters are
 * links, and every action is a plain form post carrying the anti-forgery token.
 * The look is Claude Design's (style.ts); tone is a shape and a word as well
 * as a color (glyph()).
 */
import type { Ask, Block, Cell, Field, Page, Section, Tile, Tone } from './vocab.js';
import { splitPage } from './vocab.js';
import { STYLE } from './style.js';

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
  /** The household's agents, so a row naming one (`agent`) can carry its mark. */
  agents?: Record<string, { label: string; bg: string; fg: string }>;
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

const TONE_WORD: Record<Tone, string> = { ok: 'ok', warn: 'warning', bad: 'problem', muted: 'inactive' };
const GLYPH: Record<Tone, string> = {
  ok: '<circle cx="5" cy="5" r="5" fill="currentColor"/>',
  warn: '<path d="M5 .6 9.8 9.4H.2z" fill="currentColor"/>',
  bad: '<path d="M5 0 10 5 5 10 0 5z" fill="currentColor"/>',
  muted: '<circle cx="5" cy="5" r="4" fill="none" stroke="currentColor" stroke-width="1.6"/>',
};
/** A tone's shape (● ▲ ◆ ○), in its color, named for a screen reader. */
export function glyph(t?: Tone): string {
  return t ? `<svg class="glyph" viewBox="0 0 10 10" role="img" aria-label="${TONE_WORD[t]}" style="color:var(--tone)">${GLYPH[t]}</svg>` : '';
}
const CHEVRON = '<svg class="chev" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="m6 3 5 5-5 5" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>';
const OUT = '<svg class="arrow" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M5 11 11 5M6 5h5v5" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>';

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
      // Four options or fewer, none with a detail line: a segmented control.
      if ((f.options ?? []).length <= 4 && !(f.options ?? []).some((o) => o.detail)) {
        return `<fieldset class="field"><legend>${esc(f.label)}</legend><div class="segmented">${(f.options ?? []).map((o, i) =>
          `<label><input type="radio" name="${esc(f.name)}" value="${esc(o.value)}"${f.value === o.value || (!f.value && i === 0 && f.required) ? ' checked' : ''}${req && i === 0 ? ' required' : ''}><span>${esc(o.label)}</span></label>`).join('')}</div>${hint}</fieldset>`;
      }
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
      // Two up; past four they become one swipeable strip on a phone.
      return `<dl class="stats${b.items.length > 4 ? ' strip' : ''}">${b.items.map((i) =>
        `<div class="stat${tone(i.tone)}"><dt>${esc(i.label)}</dt><dd class="value" title="${esc(i.value)}">${esc(i.value)}</dd>${
          i.detail ? `<dd class="detail">${esc(i.detail)}</dd>` : ''}${glyph(i.tone)}${
          i.page !== undefined ? `<a class="stat-link" href="${esc(pageHref(i.page, ctx.source))}" aria-label="${esc(i.label)}"></a>` : ''}</div>`).join('')}</dl>`;
    case 'list':
      if (!b.items.length) return '<p class="empty">Nothing here.</p>';
      return `<ul class="list">${b.items.map((i) => {
        const text = `<span class="text">${esc(i.text)}</span>`;
        const who = i.agent ? ctx.agents?.[i.agent] : undefined;
        return `<li class="${tone(i.tone).trim()}">${who ? mark(who, 24) : glyph(i.tone)}<span class="body">${link(text, i, ctx, 'row-link')}${
          i.meta ? `<span class="meta">${esc(i.meta)}</span>` : ''}</span>${i.badge ? `<span class="badge">${esc(i.badge)}</span>` : ''}</li>`;
      }).join('')}</ul>`;
    case 'table': {
      // A real table on a wide screen; on a phone each row is a card: column 1
      // its title, the next three label and value, the rest a tap away.
      const wide = `<div class="table-wrap"><table><thead><tr>${b.columns.map((c) => `<th scope="col">${esc(c)}</th>`).join('')}</tr></thead><tbody>${
        b.rows.map((r) => `<tr>${r.map((c) => `<td>${cell(c, ctx)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
      const pair = (r: Cell[], k: number) => `<dt>${esc(b.columns[k] ?? '')}</dt><dd>${cell(r[k] ?? '', ctx)}</dd>`;
      const cards = `<div class="table-cards" aria-hidden="true">${b.rows.map((r) => {
        const shown = [1, 2, 3].filter((k) => k < r.length).map((k) => pair(r, k)).join('');
        const rest = r.slice(4).map((_, j) => pair(r, j + 4)).join('');
        return `<div class="tcard"><span class="ttitle">${cell(r[0] ?? '', ctx)}</span>${shown ? `<dl>${shown}</dl>` : ''}${
          rest ? `<details><summary>+ ${r.length - 4} more field${r.length - 4 === 1 ? '' : 's'}</summary><dl>${rest}</dl></details>` : ''}</div>`;
      }).join('')}</div>`;
      return wide + cards;
    }
    case 'kv':
      // A value over about 24 characters drops below its label.
      return `<dl class="kv">${b.items.map((i) =>
        `<div${i.value.length > 24 ? ' class="long"' : ''}><dt>${esc(i.label)}</dt><dd>${i.page !== undefined ? link(esc(i.value), { page: i.page }, ctx) : esc(i.value)}</dd></div>`).join('')}</dl>`;
    case 'text': {
      const long = b.text.length > 360 || b.text.split('\n').length > 6;
      const body = `<span class="${long ? 'clamp' : ''}" ${long ? 'data-clamp' : ''}>${esc(b.text)}</span>`;
      return `<p class="text-block${tone(b.tone)}">${b.tone && b.tone !== 'muted' ? glyph(b.tone) : ''}${body}</p>${long ? '<button class="more" type="button" data-more hidden>More</button>' : ''}`;
    }
    case 'callout':
      return `<div class="callout${tone(b.tone)}">${b.tone && b.tone !== 'muted' ? glyph(b.tone) : ''}<div>${b.title ? `<strong>${esc(b.title)}</strong>` : ''}<p>${esc(b.text)}</p></div></div>`;
    case 'link': {
      // Leaving loom: an arrow out and the domain, always shown.
      if (b.href) {
        let host = '';
        try { host = new URL(b.href).host; } catch { /* validated already */ }
        return link(`<span><span>${esc(b.text)}</span><span class="domain mono">${esc(host)}</span></span>${OUT}`, b, ctx, 'link-row');
      }
      return link(`<span>${esc(b.text)}</span>${CHEVRON}`, b, ctx, 'link-row');
    }
    case 'filters': {
      const current = ctx.query[b.param] ?? '';
      // An optional search field over the pills: a plain GET to this page with ?q=, the other choices kept.
      const search = b.search === undefined ? '' : `<form class="filter-search" method="get" action="${esc(pageHref(ctx.path, ctx.source))}" role="search">${
        hiddenInputs(Object.fromEntries(Object.entries(ctx.query).filter(([k]) => k !== 'q')))}<input type="search" name="q" value="${esc(ctx.query.q ?? '')}" placeholder="${esc(b.search)}" aria-label="${esc(b.search)}"></form>`;
      return `${search}<nav class="filters" aria-label="Filter">${b.options.map((o) => {
        const href = pageHref(ctx.path, ctx.source);
        const target = href + qs({ ...ctx.query, [b.param]: o.value });
        const on = o.value === current;
        return `<a class="pill${on ? ' on' : ''}" href="${esc(target)}"${on ? ' aria-current="true"' : ''}>${esc(o.label)}</a>`;
      }).join('')}</nav>`;
    }
    case 'details':
      return `<details class="details"><summary><span class="body"><span class="text">${esc(b.summary)}</span>${b.meta ? `<span class="meta">${esc(b.meta)}</span>` : ''}</span>${CHEVRON}</summary><div class="details-body">${
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
      // Three or more wrap to full-width rows.
      return `<div class="buttons${b.items.length >= 3 ? ' wide' : ''}">${b.items.map((i) => actionForm(
        ctx,
        i.action,
        `${hiddenInputs(i.fields ?? {})}<button class="btn${i.tone ? ` ${i.tone}` : ''}" type="submit"${
          i.tone === 'danger' ? ` data-confirm="${esc(i.confirm ?? 'This can\'t be undone from here.')}"` : ''}>${esc(i.label)}</button>`,
        'button-form',
      )).join('')}</div>`;
    case 'meter':
      return `<div class="meters">${b.items.map((i) => {
        const pct = Math.round(i.value * 100);
        const g = i.tone && i.tone !== 'ok' ? glyph(i.tone) : '';
        return `<div class="meter${tone(i.tone)}"><div class="meter-head"><span>${esc(i.label)}</span><span class="pct">${g}${pct}%</span></div>` +
          `<div class="bar" role="meter" aria-label="${esc(i.label)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><span style="width:${pct}%"></span></div>${
            i.detail ? `<span class="meta">${esc(i.detail)}</span>` : ''}</div>`;
      }).join('')}</div>`;
    case 'code':
      // The Copy button is loom's own (app.js); off https it selects the text instead.
      return `<div class="code-block${b.label ? '' : ' nolabel'}">${b.label ? `<span class="meta">${esc(b.label)}</span>` : ''}<button class="btn copy" type="button" data-copy>Copy</button><pre><code>${esc(b.text)}</code></pre></div>`;
    case 'status':
      return `<ul class="status">${b.items.map((i) => {
        const t = i.tone ?? 'muted';
        const label = `<span class="label">${esc(i.label)}</span>`;
        return `<li class="tone-${t}">${glyph(t)}<span class="body">${i.page !== undefined ? link(label, { page: i.page }, ctx) : label}${
          i.text ? `<span class="text">${esc(i.text)}</span>` : ''}</span>${i.meta ? `<span class="meta">${esc(i.meta)}</span>` : ''}</li>`;
      }).join('')}</ul>`;
  }
}

// Ids are namespaced (s-<source>--<id>) so no piece's anchors can land on another's or on loom's.
function renderSection(s: Section, ctx: RenderContext, headingLevel = 2): string {
  if (!s.blocks.length && !s.title) return '';
  const id = `s-${esc(ctx.source.id)}--${esc(s.id)}`;
  const body = s.blocks.map((b) => renderBlock(b, ctx)).join('');
  // A tone tints only the header band, with its glyph and word; the body stays plain.
  if (s.tone && s.tone !== 'muted') {
    const h = s.title ? `<h${headingLevel}>${esc(s.title)}</h${headingLevel}>` : '<span></span>';
    return `<section class="card toned${tone(s.tone)}" id="${id}"><div class="band">${h}<span class="tone-word">${glyph(s.tone)}${TONE_WORD[s.tone]}</span></div>${body}</section>`;
  }
  const h = s.title ? `<h${headingLevel}>${esc(s.title)}</h${headingLevel}>` : '';
  return `<section class="card" id="${id}">${h}${body}</section>`;
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
  flash?: { ok: boolean; message: string; from?: string; keep?: boolean };
  skipped: string[];
  /** The app shell (bottom bar, rail, scope and Places sheets); absent for the bare pages. */
  shell?: Shell;
}

/** An agent as the shell draws it: its mark is its initial on its color. */
export interface AgentView { id: string; label: string; bg: string; fg: string; href: string; current: boolean; /** What waits on this agent: its proposals, and asks that name it. */ asks?: number }

export interface Shell {
  owner: string;
  /** 'household', or the selected agent's id. */
  scope: string;
  household: boolean;
  agents: AgentView[];
  /** Asks waiting, for the scope sheet's count. */
  asks: number;
  /** Where the Home tab goes in this scope. */
  home: string;
  /** A page below the top: where its back link goes, by name ("‹ Knowledge"). */
  back?: { label: string; href: string };
  /** Loom's own places: Knowledge, People (and Mind for a lone agent). */
  core: Array<{ label: string; href: string; current: boolean }>;
  /** Installed pieces with a tab, each with its tile's value or tone. */
  pieces: Array<{ label: string; href: string; current: boolean; tone?: Tone; stat?: string }>;
  /** The page being shown, for the active tab: 'home', 'places', 'find', 'scope' or ''. */
  tab: string;
}


/**
 * A page that stays fresh says how often (data-live, seconds): the page's
 * script re-fetches it in place. Without script, the old meta refresh.
 */
const HEAD_APP = '<link rel="manifest" href="/manifest.webmanifest"><link rel="icon" href="/icons/loom.svg" type="image/svg+xml"><link rel="apple-touch-icon" href="/icons/loom-180.png">' +
  '<meta name="theme-color" content="#F4F3EE" media="(prefers-color-scheme: light)"><meta name="theme-color" content="#0E0E0D" media="(prefers-color-scheme: dark)"><meta name="apple-mobile-web-app-capable" content="yes">';

function document(title: string, body: string, refresh: boolean | number): string {
  const every = refresh === true ? LIVE_S : refresh || 0;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${
    every ? `<noscript><meta http-equiv="refresh" content="${refresh === true ? 60 : every}"></noscript>` : ''}<title>${esc(title)}</title>${HEAD_APP}<style>${STYLE}</style><script src="/app.js" defer></script></head><body${
    every ? ` data-live="${every}"` : ''}>${body}<div class="toasts" role="status" aria-live="polite"></div></body></html>`;
}

function chromeTop(c: Chrome): string {
  const core = c.nav.filter((n) => !n.piece);
  const pieces = c.nav.filter((n) => n.piece);
  const tab = (n: Chrome['nav'][number]) => `<a href="${esc(n.href)}"${n.current ? ' aria-current="page"' : ''}>${esc(n.label)}</a>`;
  return `<header class="top"><div class="top-in"><a class="brand" href="/"><svg width="20" height="20" viewBox="0 0 22 22" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M3 5h16M3 11h16M3 17h16"></path><path d="M7 2v18M15 2v18" opacity=".55"></path></svg>loom <span class="who">· ${esc(c.agent)}</span></a>` +
    `<nav class="tabs" aria-label="Sections">${core.map(tab).join('')}${pieces.length ? `<span class="sep" aria-hidden="true"></span>${pieces.map(tab).join('')}` : ''}</nav>` +
    `<div class="top-right"><span class="mono clock">${esc(c.clock)}</span><a class="mono" href="/passkeys">Passkeys</a><form class="inline" method="post" action="/logout"><input type="hidden" name="_csrf" value="${esc(c.csrf)}"><button type="submit">Sign out</button></form></div></div></header>`;
}


// ─── The app shell (Claude Design, 2026-10-26): rail on a wide screen, bottom bar on a phone ───

const ICON = {
  home: '<svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 11 12 4l8 7v8a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>',
  places: '<svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.8"><rect x="4" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5"/></g></svg>',
  find: '<svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/></g></svg>',
  back: '<svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><path d="m14.5 5-7 7 7 7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  close: '<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  updown: '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="m5 6 3-3 3 3M5 10l3 3 3-3" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>',
  plus: '<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
};

/** loom's wordmark: the woven 2x2. */
const LOGO = '<svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><rect x="1" y="1" width="8" height="8" rx="2" fill="var(--ink)"/><rect x="11" y="1" width="8" height="8" rx="2" fill="var(--thread)" stroke="var(--ink)" stroke-width="1.2"/><rect x="1" y="11" width="8" height="8" rx="2" fill="var(--thread)" stroke="var(--ink)" stroke-width="1.2"/><rect x="11" y="11" width="8" height="8" rx="2" fill="var(--ink)"/></svg>';

/** An agent's mark: its initial on its color (colors are validated #rrggbb). */
export function mark(a: { label: string; bg: string; fg: string }, size = 28): string {
  const initial = (a.label.trim()[0] ?? '?').toUpperCase();
  return `<span class="mark" style="width:${size}px;height:${size}px;font-size:${Math.round(size * 0.5)}px;background:${a.bg};color:${a.fg}" aria-hidden="true">${esc(initial)}</span>`;
}

/** The household's mark: a woven 2x2 of ink and each agent's color. */
function householdMark(agents: AgentView[], size = 28): string {
  // The ink squares follow the text color, so the mark holds on a selected (inked) row too.
  const fills = [0, 1, 2, 3].map((i) => (i === 0 || i === 3 ? 'currentColor' : agents[i === 1 ? 0 : 1]?.bg ?? 'var(--ink-2)'));
  const c = size / 2 - 1.5;
  return `<svg class="hmark" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" aria-hidden="true">${fills.map((f, i) =>
    `<rect x="${(i % 2) * (c + 3)}" y="${Math.floor(i / 2) * (c + 3)}" width="${c}" height="${c}" rx="${Math.max(2, c * 0.27)}" fill="${f}"/>`).join('')}</svg>`;
}

function scopeMark(sh: Shell, size = 28): string {
  const a = sh.agents.find((x) => x.current);
  return sh.scope === 'household' || !a ? householdMark(sh.agents, size) : mark(a, size);
}

function signOut(c: Chrome, cls = ''): string {
  return `<form class="inline${cls ? ` ${cls}` : ''}" method="post" action="/logout"><input type="hidden" name="_csrf" value="${esc(c.csrf)}"><button type="submit">Sign out</button></form>`;
}

function scopeSheetBody(c: Chrome, sh: Shell): string {
  const row = (href: string, m: string, label: string, sub: string, current: boolean, count?: number) =>
    `<a class="scope-row${current ? ' on' : ''}" href="${esc(href)}"${current ? ' aria-current="true"' : ''}>${m}<span class="body"><span class="text">${esc(label)}</span>${sub ? `<span class="sub">${esc(sub)}</span>` : ''}</span>${
      count ? `<span class="count">${count}</span>` : ''}</a>`;
  const rows = sh.household
    ? [row('/scope/household', householdMark(sh.agents, 32), 'Household', sh.agents.map((a) => a.label).join(', '), sh.scope === 'household', sh.asks),
      ...sh.agents.map((a) => row(a.href, mark(a, 32), a.label, '', a.current, a.asks)),
      `<a class="scope-row new" href="/new-agent"><span class="plusbox">${ICON.plus}</span><span class="text">New agent</span></a>`]
    : [row('/', mark(sh.agents[0], 32), sh.agents[0].label, '', true, sh.asks)];
  return `<div class="sheet-rows">${rows.join('')}</div><div class="sheet-foot"><span class="owner">${esc(sh.owner)}</span><a class="btn small" href="/passkeys">Passkeys</a>${signOut(c, 'small')}</div>`;
}

function placesSheetBody(sh: Shell): string {
  const tiles = sh.pieces.map((p) => `<a class="place${p.current ? ' on' : ''}${tone(p.tone)}" href="${esc(p.href)}"><span class="pl-top">${glyph(p.tone === 'ok' ? undefined : p.tone)}</span><span class="pl-label">${esc(p.label)}</span>${
    p.stat ? `<span class="pl-stat">${esc(p.stat)}</span>` : ''}</a>`).join('');
  return `${tiles ? `<div class="place-grid">${tiles}</div>` : '<p class="empty">No pieces yet.</p>'}<div class="place-core">${sh.core.map((x) =>
    `<a class="place-btn${x.current ? ' on' : ''}" href="${esc(x.href)}">${esc(x.label)}</a>`).join('')}</div><a class="manage-link" href="/pieces">Manage pieces</a>`;
}

function sheet(id: string, title: string, body: string): string {
  return `<dialog class="sheet" id="sheet-${id}" aria-label="${esc(title)}"><div class="sheet-grip" aria-hidden="true"></div><div class="sheet-head"><h2>${esc(title)}</h2><button class="sheet-close" type="button" data-close aria-label="Close">${ICON.close}</button></div>${body}</dialog>`;
}

function rail(c: Chrome, sh: Shell): string {
  const cur = sh.agents.find((a) => a.current);
  const scopeLabel = sh.scope === 'household' || !cur ? 'Household' : cur.label;
  const scopeSub = sh.scope === 'household' ? sh.agents.map((a) => a.label).join(', ') : sh.household ? 'one agent' : '';
  const item = (href: string, label: string, current: boolean, extra = '') => `<a class="rail-link${current ? ' on' : ''}" href="${esc(href)}"${current ? ' aria-current="page"' : ''}><span>${esc(label)}</span>${extra}</a>`;
  return `<aside class="rail" aria-label="loom"><a class="wordmark" href="/">${LOGO}<span>loom</span></a>` +
    `<a class="scope-btn" href="/scope" data-sheet="scope">${scopeMark(sh, 32)}<span class="body"><span class="text">${esc(scopeLabel)}</span>${scopeSub ? `<span class="sub">${esc(scopeSub)}</span>` : ''}</span>${ICON.updown}</a>` +
    `<a class="find-btn" href="/find" data-sheet="find">${ICON.find}<span>Find anything</span><kbd>⌘K</kbd></a>` +
    `<nav class="rail-nav">${item(sh.home, 'Home', sh.tab === 'home', sh.asks ? `<span class="count">${sh.asks}</span>` : '')}${sh.core.map((x) => item(x.href, x.label, x.current)).join('')}` +
    (sh.pieces.length ? `<span class="rail-label">Pieces</span>${sh.pieces.map((p) => item(p.href, p.label, p.current, p.tone && p.tone !== 'ok' ? glyph(p.tone) : '')).join('')}` : '') +
    `<a class="rail-link quiet" href="/pieces">Manage pieces…</a></nav>` +
    `<div class="rail-foot"><span>${esc(sh.owner)}</span><a href="/passkeys">Passkeys</a>${signOut(c)}</div></aside>`;
}

function phoneTop(sh: Shell): string {
  // Home shows the wordmark; anywhere else a way back.
  return sh.tab === 'home' && !sh.back
    ? `<div class="phone-top"><a class="wordmark" href="/">${LOGO}<span>loom</span></a></div>`
    : sh.back
      ? `<div class="phone-top"><a class="back named" href="${esc(sh.back.href)}">${ICON.back}<span>${esc(sh.back.label)}</span></a></div>`
      : `<div class="phone-top"><a class="back" href="${esc(sh.home)}" aria-label="Home">${ICON.back}</a></div>`;
}

function bottomBar(sh: Shell): string {
  const tab = (href: string, label: string, icon: string, on: boolean, attrs = '') =>
    `<a class="tab${on ? ' on' : ''}" href="${esc(href)}" aria-label="${esc(label)}"${on ? ' aria-current="page"' : ''}${attrs}>${icon}</a>`;
  return `<nav class="bottom" aria-label="Main"><a class="scope-chip" href="/scope" data-sheet="scope" aria-label="Scope: ${esc(sh.scope === 'household' ? 'Household' : sh.agents.find((a) => a.current)?.label ?? '')}">${scopeMark(sh, 30)}<span class="caret" aria-hidden="true">⌃</span></a>` +
    tab(sh.home, 'Home', ICON.home, sh.tab === 'home') + tab('/places', 'Places', ICON.places, sh.tab === 'places', ' data-sheet="places"') + tab('/find', 'Find', ICON.find, sh.tab === 'find', ' data-sheet="find"') + '</nav>';
}

/** Everything around a page's main: the rail, the phone's top and bottom bars, and the two sheets. */
function shellOpen(c: Chrome): string {
  if (!c.shell) return chromeTop(c);
  return `<div class="app">${rail(c, c.shell)}<div class="content">${phoneTop(c.shell)}`;
}
function shellClose(c: Chrome, foot: string): string {
  if (!c.shell) return foot;
  return `${foot}</div></div>${bottomBar(c.shell)}${sheet('scope', 'Show me', scopeSheetBody(c, c.shell))}${sheet('places', 'Places', placesSheetBody(c.shell))}` +
    `<dialog class="sheet find-sheet" id="sheet-find" aria-label="Find">${findBody(c, '')}</dialog>`;
}

/** The sheets as pages (no script, or a link straight to them), and Find. */
/** Find's other groups, from the handler: what needs doing, and the household's knowledge, people and memories. */
export interface Found {
  do: Array<{ label: string; href: string }>;
  knowledge: Array<{ label: string; href: string }>;
  people: Array<{ label: string; href: string }>;
  memories: Array<{ label: string; href: string; agent: string }>;
}

/** The first match in bold: "Sign <strong>Disc</strong>ord bridge back in". */
function lit(text: string, q: string): string {
  const i = q ? text.toLowerCase().indexOf(q.toLowerCase()) : -1;
  return i < 0 ? esc(text) : `${esc(text.slice(0, i))}<strong>${esc(text.slice(i, i + q.length))}</strong>${esc(text.slice(i + q.length))}`;
}

/** Find, as the design's palette: a field and Cancel, then Do · Go to · Memories. A blank field lists the places. */
function findBody(c: Chrome, q: string, found?: Found): string {
  const sh = c.shell!;
  const term = q.trim();
  const places = [{ label: 'Home', href: sh.home }, ...sh.core, ...sh.pieces, { label: 'Manage pieces', href: '/pieces' }, { label: 'Passkeys', href: '/passkeys' },
    ...sh.agents.filter(() => sh.household).map((a) => ({ label: a.label, href: `/scope/${a.id}` }))];
  const go = [
    ...places.filter((x) => !term || x.label.toLowerCase().includes(term.toLowerCase())).map((x) => ({ html: lit(x.label, term), href: x.href })),
    ...(found?.knowledge ?? []).map((x) => ({ html: `Knowledge › ${lit(x.label, term)}`, href: x.href })),
    ...(found?.people ?? []).map((x) => ({ html: `People › ${lit(x.label, term)}`, href: x.href })),
  ];
  const row = (href: string, inner: string, lead = '') => `<a class="find-row" href="${esc(href)}">${lead}<span class="ft">${inner}</span></a>`;
  const group = (title: string, rows: string[]) => rows.length ? `<section class="find-group"><h2 class="label">${title}</h2><div class="card rows">${rows.join('')}</div></section>` : '';
  const results = group('Do', (found?.do ?? []).map((x) => row(x.href, lit(x.label, term), '<span class="do-dot" aria-hidden="true"></span>'))) +
    group('Go to', go.map((x) => row(x.href, x.html))) +
    group('Memories', (found?.memories ?? []).map((x) => {
      const who = sh.agents.find((a) => a.id === x.agent);
      return row(x.href, lit(x.label, term), who ? mark(who, 22) : '');
    }));
  return `<form class="find-form" method="get" action="/find" role="search"><input type="search" name="q" value="${esc(q)}" placeholder="Find anything" aria-label="Find" autocomplete="off" autofocus>` +
    `<a class="find-cancel" href="${esc(sh.home)}" data-close>Cancel</a></form>` +
    `<div class="find-results" aria-live="polite">${results || `<p class="empty">Nothing matches “${esc(term)}”.</p>`}</div>`;
}

export function renderSheetPage(which: 'scope' | 'places' | 'find', c: Chrome, q = '', found?: Found): string {
  const sh = c.shell!;
  let inner: string;
  if (which === 'scope') inner = `<h1>Show me</h1>${scopeSheetBody(c, sh)}`;
  else if (which === 'places') inner = `<h1>Places</h1>${placesSheetBody(sh)}`;
  else inner = `<h1 class="visually-hidden">Find</h1>${findBody(c, q, found)}`;
  return document(which === 'scope' ? 'Show me' : which === 'places' ? 'Places' : 'Find', `${shellOpen(c)}<main class="sheet-page">${inner}</main>${shellClose(c, '')}`, false);
}

/** How often a live page checks in, with script. */
export const LIVE_S = 20;

function chromeFoot(c: Chrome, refresh: boolean): string {
  return `<footer>${refresh ? '<span data-live-status>Refreshes every minute.</span>' : ''}${c.skipped.length ? `<span>Pieces with no page: ${c.skipped.map(esc).join(', ')}</span>` : ''}</footer>`;
}

function flash(c: Chrome): string {
  if (!c.flash) return '';
  const from = c.flash.from ? `<span class="from">${esc(c.flash.from)}</span>` : '';
  return `<div class="flash ${c.flash.ok ? 'ok' : 'bad'}" role="status"${c.flash.keep ? ' data-keep' : ''}>${c.flash.ok ? glyph('ok') : glyph('bad')}<span>${esc(c.flash.message)}</span>${from}</div>`;
}

/** One page, loom's or a piece's. An agent's Mind, People or Setup passes its head: the page's title gives way to the agent's. */
export function renderPage(page: Page, ctx: RenderContext, chrome: Chrome, unscopedFor?: string, head?: AgentHead): string {
  const main = page.sections.filter((s) => !s.side).map((s) => renderSection(s, ctx)).join('');
  const side = page.sections.filter((s) => s.side).map((s) => renderSection(s, ctx)).join('');
  // A page with nothing on it says whose it is: "Tasks has nothing yet.", under its intro.
  const empty = page.sections.length ? '' : `<p class="empty-state">${esc(page.title === 'Not found' ? 'There\'s nothing here.' : `${page.title} has nothing yet.`)}</p>`;
  // Pages with forms don't auto-refresh: a refresh would throw away what's being typed.
  const hasForm = page.sections.some((s) => s.blocks.some((b) => b.type === 'form' || (b.type === 'details' && b.blocks.some((x) => x.type === 'form'))));
  // A piece that can't narrow to the selected agent: one quiet line, the household's mark.
  const unscoped = unscopedFor && chrome.shell
    ? `<p class="unscoped">${householdMark(chrome.shell.agents, 24)}<span>Showing the whole household — this piece can't narrow to ${esc(unscopedFor)}.</span></p>` : '';
  const body = `${shellOpen(chrome)}<main${head ? ' class="agent-page"' : ''}>${flash(chrome)}${head ? agentHead(head) : `<div><h1>${esc(page.title)}</h1>`}${page.intro ? `<p class="intro">${esc(page.intro)}</p>` : ''}${head ? '' : '</div>'}${unscoped}${empty}${columns(main, side)}</main>${shellClose(chrome, chromeFoot(chrome, !hasForm && !page.refresh))}`;
  // A page that asks for its own refresh (an install running) gets it, forms or not.
  return document(`${page.title} · ${chrome.agent}`, body, page.refresh ?? !hasForm);
}

/** "Your call" shows this many a piece on Home; the rest are a link away. */
const ASKS_SHOWN = 5;

export interface HomeTile extends Tile { source: Source }
export interface HomeAsk extends Ask { source: Source; /** The piece's tab label, for the card's source line. */ sourceLabel?: string }

/** Home: tiles across the top, the tape as the page, "Your call" leading the side column. */
export function renderHome(page: Page, ctx: RenderContext, chrome: Chrome, tiles: HomeTile[], asks: HomeAsk[]): string {
  const tileHtml = tiles.length
    ? `<section class="tiles" aria-label="Status">${tiles.map((t) => {
        const inner = `<span class="eyebrow">${esc(t.label)}</span><span class="value">${esc(t.value)}</span>${t.detail ? `<span class="detail">${esc(t.detail)}</span>` : ''}${glyph(t.tone)}`;
        return t.page !== undefined
          ? `<a class="tile${tone(t.tone)}" href="${esc(pageHref(t.page, t.source))}">${inner}</a>`
          : `<div class="tile${tone(t.tone)}">${inner}</div>`;
      }).join('')}</section>`
    : '';
  const bySource = new Map<string, HomeAsk[]>();
  for (const a of asks) bySource.set(a.source.id, [...(bySource.get(a.source.id) ?? []), a]);
  const askItems = [...bySource.values()].flatMap((list) => {
    const shown = list.slice(0, ASKS_SHOWN).map((a) => {
      const go = a.page !== undefined ? `<a class="go" href="${esc(pageHref(a.page, a.source))}">${esc(a.label ?? 'Open')}</a>` : '';
      return `<li class="ask"><span class="src"><span>${esc(a.source.id === 'loom' ? 'loom' : a.source.id)}</span></span><span class="text">${esc(a.text)}</span>${a.meta ? `<span class="sentence">${esc(a.meta)}</span>` : ''}${go}</li>`;
    });
    const rest = list.length - ASKS_SHOWN;
    if (rest > 0) shown.push(`<li><a href="${esc(pageHref('', list[0].source))}">${rest} more from ${esc(list[0].source.id)}</a></li>`);
    return shown;
  });
  const yours = askItems.length ? `<section class="your-call" id="your-call"><h2 class="label">Your call</h2><ul class="ask-list">${askItems.join('')}</ul></section>` : '';
  const main = page.sections.filter((s) => !s.side).map((s) => renderSection(s, ctx)).join('');
  // Your call comes first, in every scope and at every width (the design's rule 9).
  const sideRest = page.sections.filter((s) => s.side).map((s) => renderSection(s, ctx)).join('');
  const body = `${shellOpen(chrome)}<main>${flash(chrome)}${yours}${tileHtml}${columns(main, sideRest)}</main>${shellClose(chrome, chromeFoot(chrome, true))}`;
  return document(chrome.agent, body, true);
}

// ─── Home and an agent's Today (Claude Design, 2026-10-26) ───────────────────

export interface ThreadRow { agent?: string; text: string; meta: string; at: string; page?: string }

/** Everything Home (or an agent's Today) shows, in the design's order. */
export interface Dashboard {
  /** 'Household', or the agent's name. */
  label: string;
  /** An agent's Today: its mark, and Today · Mind · People · Setup. */
  agent?: { label: string; bg: string; fg: string; sub?: string; tabs: Array<{ label: string; href: string; current: boolean }> };
  asks: HomeAsk[];
  tiles: HomeTile[];
  thread: ThreadRow[];
  /** "Since you last looked" (epoch ms); rows after it get a new dot, and a line marks it. */
  sinceMs?: number;
  sinceLabel?: string;
  /** Pills over the Thread: All and each agent. */
  filters?: { param: string; current: string; options: Array<{ value: string; label: string }> };
  shared?: { pages: number; people: number };
  more?: { label: string; href: string };
  /** First run (no pieces yet): a line under the headline, and a couple of catalog pieces to install. */
  firstRun?: { line: string; starters: Array<{ name: string; label: string; what: string }> };
}

/** "40m", "2h", "3d": how long ago, short. */
export function age(iso: string | undefined, nowMs = Date.now()): string {
  const t = iso ? Date.parse(iso) : Number.NaN;
  if (Number.isNaN(t)) return '';
  const m = Math.max(0, Math.round((nowMs - t) / 60_000));
  return m < 60 ? `${m}m` : m < 60 * 48 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
}

function askCard(a: HomeAsk, agents: RenderContext['agents'], nowMs: number): string {
  const who = a.agent ? agents?.[a.agent] : undefined;
  const src = `${who ? mark(who, 20) : glyph(a.tone)}<span>${esc(a.sourceLabel ?? a.source.id)}</span>`;
  const go = a.page !== undefined ? `<a class="go" href="${esc(pageHref(a.page, a.source))}">${esc(a.label ?? 'Open')}</a>` : '';
  return `<li class="ask${a.tone && a.tone !== 'ok' && a.tone !== 'muted' ? tone(a.tone) : ''}"><span class="src"><span class="who">${src}</span>${a.at ? `<span class="mono">${esc(age(a.at, nowMs))}</span>` : ''}</span>` +
    `<span class="text">${esc(a.text)}</span>${a.meta ? `<span class="sentence">${esc(a.meta)}</span>` : ''}${go}</li>`;
}

export type AgentHead = NonNullable<Dashboard['agent']>;

/** An agent's own pages open with its mark and name, then Today · Mind · People · Setup. */
function agentHead(a: AgentHead): string {
  return `<header class="dash-head agent">${mark(a, 48)}<div><h1>${esc(a.label)}</h1>${a.sub ? `<p class="sub">${esc(a.sub)}</p>` : ''}</div></header>` +
    `<nav class="seg-tabs" aria-label="${esc(a.label)}">${a.tabs.map((t) => `<a href="${esc(t.href)}"${t.current ? ' class="on" aria-current="page"' : ''}>${esc(t.label)}</a>`).join('')}</nav>`;
}

export function renderDashboard(d: Dashboard, ctx: RenderContext, chrome: Chrome, nowMs = Date.now()): string {
  const need = d.asks.length;
  const fresh = d.sinceMs === undefined ? 0 : d.thread.filter((r) => Date.parse(r.at) > d.sinceMs!).length;
  const head = d.agent
    ? agentHead(d.agent)
    : `<header class="dash-head"><span class="label">${esc(d.label)}</span><h1 class="display">${need ? `${need} need${need === 1 ? 's' : ''} you` : 'Nothing needs you'}</h1>${
      d.sinceLabel && (fresh || !d.firstRun) ? `<p class="sub">${fresh} new since ${esc(d.sinceLabel)}</p>` : ''}${d.firstRun ? `<p class="sub">${esc(d.firstRun.line)}</p>` : ''}</header>`;
  const starters = d.firstRun?.starters.length
    ? `<section class="starters"><h2 class="label">Start with these</h2><div class="card rows">${d.firstRun.starters.map((s) =>
        `<div class="starter"><span class="body"><span class="text">${esc(s.label)}</span><span class="meta">${esc(s.what)}</span></span>${
          actionForm({ ...ctx, source: CORE, path: '', query: {} }, 'piece-install', `${hiddenInputs({ name: s.name })}<button class="btn small" type="submit">Install</button>`, 'button-form')}</div>`).join('')}</div></section>` : '';
  const yours = need
    ? `<section class="your-call" id="your-call"><h2 class="label">Your call <span class="n">${need}</span></h2><ul class="ask-list">${d.asks.map((a) => askCard(a, ctx.agents, nowMs)).join('')}</ul></section>` : '';
  const glance = d.tiles.length
    ? `<section class="glance"><h2 class="label">At a glance</h2><div class="tiles">${d.tiles.map((t) => {
        const inner = `<span class="eyebrow">${esc(t.label)}</span><span class="value">${esc(t.value)}</span>${t.detail ? `<span class="detail">${esc(t.detail)}</span>` : ''}${glyph(t.tone === 'ok' ? undefined : t.tone)}`;
        return t.page !== undefined ? `<a class="tile${tone(t.tone)}" href="${esc(pageHref(t.page, t.source))}">${inner}</a>` : `<div class="tile${tone(t.tone)}">${inner}</div>`;
      }).join('')}</div></section>` : '';
  let divided = false;
  const rows = d.thread.map((r) => {
    const isNew = d.sinceMs !== undefined && Date.parse(r.at) > d.sinceMs;
    let line = '';
    if (!isNew && !divided && d.sinceMs !== undefined && fresh > 0) { divided = true; line = `<li class="seen"><span>seen up to ${esc(d.sinceLabel ?? '')}</span></li>`; }
    const who = r.agent ? ctx.agents?.[r.agent] : undefined;
    const text = `<span class="text">${esc(r.text)}</span>`;
    return `${line}<li data-key="${esc(`${r.agent ?? ''}|${r.at}|${r.text}`)}">${who ? mark(who, 24) : ''}<span class="body">${link(text, r, ctx, 'row-link')}<span class="meta">${esc(r.meta)}</span></span>${isNew ? '<span class="new" aria-label="new"></span>' : ''}</li>`;
  }).join('');
  const filters = d.filters ? renderBlock({ type: 'filters', param: d.filters.param, options: d.filters.options }, ctx) : '';
  const thread = `<section class="thread"><h2 class="label">Thread</h2>${filters}<ul class="list thread-list">${rows || '<li><span class="empty">Nothing in the last day.</span></li>'}</ul>${
    d.more ? `<a class="more-link" href="${esc(d.more.href)}">${esc(d.more.label)}</a>` : ''}</section>`;
  const shared = d.shared
    ? `<section class="shared"><h2 class="label">Shared</h2><div class="card rows"><a class="link-row" href="/knowledge"><span><span>Knowledge</span><span class="domain">${d.shared.pages.toLocaleString('en-US')} facts</span></span>${CHEVRON}</a>` +
      `<a class="link-row" href="/people"><span><span>People</span><span class="domain">${d.shared.people} cards</span></span>${CHEVRON}</a></div></section>` : '';
  const body = `${shellOpen(chrome)}<main class="dash${d.agent ? ' today' : ''}">${flash(chrome)}${head}${yours}${starters}<div class="dash-cols"><div class="dash-main">${glance ? `<div class="glance-phone">${glance}</div>` : ''}${thread}</div><aside class="dash-side">${glance}${shared}</aside></div></main>${shellClose(chrome, '<footer><span data-live-status>Refreshes every minute.</span></footer>')}`;
  return document(d.label, body, true);
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
      error ? `<p class="err">${esc(error)}</p>` : ''}${pk}<input type="password" name="token" autocomplete="current-password" ${passkey.here ? '' : 'autofocus '}aria-label="token"><button type="submit"${passkey.here ? ' class="secondary"' : ''}>Open</button></form>${
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
    .replace('<noscript><meta http-equiv="refresh" content="60"></noscript>', '')
    .replace(` data-live="${LIVE_S}"`, '')
    .replace('<span data-live-status>Refreshes every minute.</span>', '')
    // The control goes first, under the title: on a phone it's what the page is for.
    .replace(/(<main>[\s\S]*?<h1>[\s\S]*?<\/div>)/, `$1${control}`)
    .replace('</body>', `${'csrf' in add ? '<script src="/login/passkey.js" defer></script>' : ''}</body>`);
}
