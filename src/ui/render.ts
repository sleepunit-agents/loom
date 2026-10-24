/**
 * Server-side HTML for loom's page. Every string that reaches the page goes
 * through esc(): pieces send data in the section vocabulary, never markup.
 * No client script; the page refreshes itself.
 */
import type { Block, Section, Tone } from './sections.js';
import type { PieceSections, PieceSkip } from './piece-sections.js';

export function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const toneClass = (t?: Tone) => (t ? ` tone-${t}` : '');

function renderBlock(b: Block): string {
  switch (b.type) {
    case 'stats':
      return `<dl class="stats">${b.items
        .map((i) => `<div class="stat${toneClass(i.tone)}"><dt>${esc(i.label)}</dt><dd>${esc(i.value)}</dd></div>`)
        .join('')}</dl>`;
    case 'list':
      return `<ul class="list">${b.items
        .map((i) => `<li class="${toneClass(i.tone).trim()}"><span class="text">${esc(i.text)}</span>${
          i.meta ? `<span class="meta">${esc(i.meta)}</span>` : ''}</li>`)
        .join('')}</ul>`;
    case 'table':
      return `<div class="table-wrap"><table><thead><tr>${b.columns.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${b.rows
        .map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`)
        .join('')}</tbody></table></div>`;
    case 'text':
      return `<p class="text-block">${esc(b.text)}</p>`;
    case 'link':
      return `<p><a href="${esc(b.href)}" rel="noopener noreferrer">${esc(b.text)}</a></p>`;
  }
}

function renderSection(s: Section, source: string): string {
  return `<section class="card" id="${esc(source)}-${esc(s.id)}"><h2>${esc(s.title)}</h2>${s.blocks.map(renderBlock).join('')}</section>`;
}

const STYLE = `
:root{--bg:#f7f7f5;--card:#fff;--fg:#1d1d1b;--muted:#6b6b66;--line:#e4e4df;--accent:#3b5bdb;--ok:#2b8a3e;--warn:#b26a00;--bad:#c92a2a;color-scheme:light}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#141413;--card:#1e1e1c;--fg:#ececea;--muted:#9a9a94;--line:#2e2e2b;--accent:#8ca2ff;--ok:#69db7c;--warn:#ffc078;--bad:#ff8787;color-scheme:dark}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}
header{padding:14px 16px 0;max-width:1100px;margin:0 auto}header h1{margin:0;font-size:18px;font-weight:600}header .sub{color:var(--muted);font-size:13px}
nav{display:flex;gap:4px;overflow-x:auto;padding:10px 16px;max-width:1100px;margin:0 auto;border-bottom:1px solid var(--line)}
nav a{color:var(--muted);text-decoration:none;padding:6px 10px;border-radius:8px;white-space:nowrap;font-size:14px}nav a:hover{background:var(--card);color:var(--fg)}
main{max-width:1100px;margin:0 auto;padding:16px}.group{margin-bottom:24px}.group>h2.source{font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:0 0 8px}
.grid{display:grid;gap:12px;align-items:start;grid-template-columns:repeat(auto-fill,minmax(min(100%,340px),1fr))}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px;min-width:0}.card h2{margin:0 0 10px;font-size:15px}
.stats{display:flex;flex-wrap:wrap;gap:16px;margin:0}.stat dt{color:var(--muted);font-size:12px}.stat dd{margin:0;font-size:22px;font-weight:600;font-variant-numeric:tabular-nums}
.list{list-style:none;margin:0;padding:0}.list li{padding:6px 0;border-top:1px solid var(--line);display:flex;flex-direction:column;gap:2px}.list li:first-child{border-top:0}
.list .meta{color:var(--muted);font-size:12px}.text-block{margin:0;color:var(--muted)}
.table-wrap{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:13px}th,td{text-align:left;padding:5px 6px;border-top:1px solid var(--line)}th{color:var(--muted);font-weight:500;border-top:0}
.tone-ok dd,.tone-ok .text{color:var(--ok)}.tone-warn dd,.tone-warn .text{color:var(--warn)}.tone-bad dd,.tone-bad .text{color:var(--bad)}.tone-muted dd,.tone-muted .text{color:var(--muted)}
a{color:var(--accent)}footer{max-width:1100px;margin:0 auto;padding:0 16px 24px;color:var(--muted);font-size:12px}
form.login{max-width:360px;margin:48px auto;padding:16px}form.login input{width:100%;padding:10px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--fg);font:inherit}
form.login button{margin-top:10px;padding:9px 14px;border:0;border-radius:8px;background:var(--accent);color:#fff;font:inherit}.err{color:var(--bad)}
`;

function shell(title: string, body: string, refresh: boolean): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${
    refresh ? '<meta http-equiv="refresh" content="30">' : ''}<title>${esc(title)}</title><style>${STYLE}</style></head><body>${body}</body></html>`;
}

export function renderPage(opts: {
  agent: string;
  core: Section[];
  pieces: PieceSections[];
  skipped: PieceSkip[];
  generatedAt: string;
}): string {
  const groups = [{ source: 'loom', sections: opts.core }, ...opts.pieces.map((p) => ({ source: p.piece, sections: p.sections }))];
  const nav = groups.map((g) => `<a href="#${esc(g.source)}">${esc(g.source)}</a>`).join('');
  const main = groups
    .map((g) => `<div class="group" id="${esc(g.source)}"><h2 class="source">${esc(g.source)}</h2><div class="grid">${
      g.sections.map((s) => renderSection(s, g.source)).join('')}</div></div>`)
    .join('');
  const quiet = opts.skipped.length ? ` · pieces with no page: ${opts.skipped.map((s) => esc(s.piece)).join(', ')}` : '';
  return shell(
    `${opts.agent} · loom`,
    `<header><h1>${esc(opts.agent)}</h1><div class="sub">loom</div></header><nav>${nav}</nav><main>${main}</main>` +
      `<footer>Updated ${esc(opts.generatedAt)} · refreshes every 30s${quiet} · <a href="/ui/logout">log out</a></footer>`,
    true,
  );
}

export function renderLogin(agent: string, error?: string): string {
  return shell(
    `${agent} · loom`,
    `<form class="login" method="post" action="/ui/login"><h1>${esc(agent)}</h1><p class="sub">loom: paste the bearer token once (it's kept as a cookie on this browser).</p>${
      error ? `<p class="err">${esc(error)}</p>` : ''}<input type="password" name="token" autocomplete="current-password" autofocus aria-label="token"><button type="submit">Open</button></form>`,
    false,
  );
}
