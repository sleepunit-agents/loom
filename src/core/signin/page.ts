import { createHash } from 'node:crypto';

/** The shell of every page the sign-in door renders itself (today one: the page a one-time link opens). It wears
 * the look of the app's own sign-in page (web/src/shell/signin.tsx, signin.css) and is whole in one answer: no
 * script, no stylesheet or font to fetch, nothing that needs a session, and nothing about the household.
 *
 * The app's page reads its look from the app's tokens (web/src/looks/looks.css); this page cannot, so it carries
 * a copy, kept in step by hand: Neon Noir's colours for dark and Daylight's for light (LOOK below), the spacing
 * steps 4, 8, 12, 16, 24, 32 px, the wordmark (700, .08em tracking, clamp(44px, 14vw, 112px), its slashes pink),
 * the 384 px panel, the 48 px pill button, and the weave (TILE, AT, GAP, WARP, WEFT, as in signin.tsx). The
 * display and text faces are not copied: a page that may fetch nothing uses the device's own. */
const LOOK = {
  dark: { canvas: '#07070C', text: '#F3F1FF', text2: '#BDB8D6', edge: '#6E6896', border: '#2B2940', pink: '#FF3DA8', pinkDeep: '#E0348F', onAccent: '#0A0912',
    blue: '#2EE6F0', yellow: '#FFC23D', olive: '#A27DFF', wash1: '24%', wash2: '20%', wash3: '8%', washDim: '.5', clothDim: '.9' },
  light: { canvas: '#F5F3EE', text: '#1F1D27', text2: '#45424F', edge: '#75717C', border: '#D3CEC5', pink: '#C2185B', pinkDeep: '#A3134C', onAccent: '#FFFFFF',
    blue: '#00727C', yellow: '#8A5A00', olive: '#6741C8', wash1: '12%', wash2: '10%', wash3: '10%', washDim: '1', clothDim: '1' },
} as const;
const tokens = (look: Record<string, string>) => Object.entries(look).map(([name, value]) => `--${name.replace(/[A-Z0-9]/g, letter => '-' + letter.toLowerCase())}:${value}`).join(';');

// One tile of plain weave: eight warp and eight weft threads, each broken where it passes under.
const TILE = 192, GAP = 5, AT = [12, 36, 60, 76, 108, 132, 156, 172];
const WARP = ['border', 'edge', 'pink', 'border', 'border', 'blue', 'edge', 'border'], WEFT = ['border', 'olive', 'border', 'edge', 'border', 'yellow', 'border', 'edge'];
function thread(i: number, weft: boolean): string {
  const line = (a: number, b: number) => weft ? `M${a} ${AT[i]}H${b}` : `M${AT[i]} ${a}V${b}`;
  let d = '', from = 0;
  for (const [j, at] of AT.entries()) if ((i + j) % 2 === (weft ? 0 : 1)) { d += line(from, at - GAP); from = at + GAP; }
  return d + line(from, TILE);
}
const WEAVE = `<svg class="cloth" aria-hidden="true" focusable="false" width="100%" height="100%"><defs><pattern id="weave" width="${TILE}" height="${TILE}" patternUnits="userSpaceOnUse">`
  + [...WEFT.map((tint, i) => [tint, thread(i, true)]), ...WARP.map((tint, i) => [tint, thread(i, false)])].map(([tint, d]) => `<path class="${tint}" d="${d}"/>`).join('')
  + '</pattern></defs><rect width="100%" height="100%" fill="url(#weave)"/></svg>';

const STYLE = [
  `:root{color-scheme:dark;${tokens(LOOK.dark)}}`,
  `@media (prefers-color-scheme:light){:root{color-scheme:light;${tokens(LOOK.light)}}}`,
  '*{box-sizing:border-box}',
  'html{-webkit-text-size-adjust:100%}',
  'body{margin:0;background:var(--canvas);color:var(--text);font:16px/24px ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}',
  'main{position:relative;isolation:isolate;min-height:100vh;min-height:100dvh;overflow:hidden;display:grid;align-items:center;padding:max(32px,env(safe-area-inset-top)) max(24px,env(safe-area-inset-right)) max(32px,env(safe-area-inset-bottom)) max(24px,env(safe-area-inset-left))}',
  '.ground{position:absolute;inset:0;z-index:-1;overflow:hidden;pointer-events:none}',
  '.wash,.veil,.cloth{position:absolute;inset:0}',
  '.wash{opacity:var(--wash-dim);background:radial-gradient(at 18% 30%,color-mix(in srgb,var(--pink) var(--wash-1),transparent),transparent 60%),radial-gradient(at 82% 72%,color-mix(in srgb,var(--blue) var(--wash-2),transparent),transparent 62%),radial-gradient(at 56% 8%,color-mix(in srgb,var(--yellow) var(--wash-3),transparent),transparent 56%)}',
  '.cloth{display:block;opacity:var(--cloth-dim)}',
  '.cloth path{fill:none;stroke:var(--border);stroke-width:1;shape-rendering:crispEdges}',
  '.cloth .edge{stroke:var(--edge)}',
  '.cloth .pink{stroke:var(--pink);stroke-width:2}.cloth .blue{stroke:var(--blue);stroke-width:2}.cloth .yellow{stroke:var(--yellow);stroke-width:2}.cloth .olive{stroke:var(--olive);stroke-width:2}',
  '.veil{background:linear-gradient(90deg,color-mix(in srgb,var(--canvas) 92%,transparent),color-mix(in srgb,var(--canvas) 80%,transparent) 40%,transparent 90%)}',
  '.column{width:min(100%,704px);margin-left:clamp(0px,8vw,128px);display:grid;gap:16px;justify-items:start}',
  '.mark{margin:0;max-width:100%;font-size:clamp(44px,14vw,112px);line-height:1;font-weight:700;letter-spacing:.08em;overflow-wrap:anywhere}',
  '.mark i{font-style:normal;color:var(--pink)}',
  '.thread{position:relative;width:min(100%,384px);height:2px;margin:8px 0;background:var(--edge)}',
  '.thread::after{content:"";position:absolute;right:0;top:0;width:32px;height:100%;background:var(--pink)}',
  '.panel{width:min(100%,384px);display:grid;gap:16px}',
  'h1{margin:0;font-size:21px;line-height:1.25;font-weight:600}',
  'form{margin:0}',
  '.panel p{margin:0;font-size:14px;line-height:20px;color:var(--text-2);overflow-wrap:anywhere}',
  'button{appearance:none;border:0;cursor:pointer;width:100%;min-height:48px;padding:12px 24px;border-radius:999px;background:var(--pink);color:var(--on-accent);font:inherit;font-weight:600;text-align:center;white-space:normal;overflow-wrap:anywhere}',
  'button:hover{background:var(--pink-deep)}',
  'button:focus-visible{outline:2px solid var(--blue);outline-offset:4px}',
  '@media (max-width:640px){.column{margin-left:0}.veil{background:linear-gradient(180deg,color-mix(in srgb,var(--canvas) 30%,transparent),color-mix(in srgb,var(--canvas) 88%,transparent) 28%,color-mix(in srgb,var(--canvas) 88%,transparent) 78%,color-mix(in srgb,var(--canvas) 40%,transparent))}}',
  '@media (prefers-contrast:more){.cloth{opacity:.45}.wash{display:none}.veil{background:color-mix(in srgb,var(--canvas) 80%,transparent)}}',
].join('');

/** The policy a page from signinPage is served under. Nothing loads and nothing runs; the one allowance is the
 * page's own style block, named by its hash, so no other inline style (a `style` attribute included) applies. */
export const SIGNIN_PAGE_POLICY = `default-src 'none'; style-src 'sha256-${createHash('sha256').update(STYLE).digest('base64')}'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`;

/** A whole page: the ground, the wordmark, the thread, then a heading and the caller's own markup under it. `title`
 * is plain words (it is the document's title and its heading); `body` is trusted markup written in this program,
 * never a value from a request or from the household. */
export function signinPage(title: string, body: string): string {
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">'
    + `<title>${title}</title><style>${STYLE}</style></head><body><main>`
    + `<div class="ground" aria-hidden="true"><div class="wash"></div>${WEAVE}<div class="veil"></div></div>`
    + '<div class="column"><p class="mark"><span aria-hidden="true">LOOM<i>//</i>OS</span></p><div class="thread" aria-hidden="true"></div>'
    + `<div class="panel"><h1>${title}</h1>${body}</div></div></main></body></html>`;
}

/** The page a one-time sign-in link opens: one form that posts back to the link's own address, and nothing else. */
export const signinLinkPage = (): string => signinPage('Sign in to loom', '<form method="post"><button>Sign in</button></form><p>This link works once and signs in this browser.</p>');
