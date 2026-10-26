/**
 * The page's stylesheet: Claude Design's foundations (2026-10-26 handoff,
 * Art notes/design/2026-10-26-loom-page/HANDOFF.md) as custom properties,
 * light and dark from prefers-color-scheme. Fonts are loom's own (/fonts/,
 * OFL): nothing on the page loads from another site.
 */
export const STYLE = `
@font-face{font-family:"Instrument Sans";src:url(/fonts/instrument-sans-latin-wght-normal.woff2) format("woff2");font-weight:400 700;font-display:swap}
@font-face{font-family:"JetBrains Mono";src:url(/fonts/jetbrains-mono-latin-wght-normal.woff2) format("woff2");font-weight:400 700;font-display:swap}
:root{--ground:#F4F3EE;--surface:#FFFFFF;--raised:#ECEBE4;--line:#DEDCD3;--ink:#161614;--ink-2:#57564F;--thread:#D4FF3A;--link:#3F5A00;
--ok:#0F6B51;--ok-bg:#E3F3EC;--warn:#8A5600;--warn-bg:#FBEFD6;--warn-fill:#C98A1A;--bad:#B42C22;--bad-bg:#FBE3E0;--muted:#57564F;--muted-bg:#ECEBE4;
--code-bg:#161614;--code-ink:#F2F1EC;--tab-on:#161614;--rail:#ECEBE4;--r-control:8px;--r-button:10px;--r-card:14px;--r-sheet:22px;color-scheme:light}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--ground:#0E0E0D;--surface:#1A1A18;--raised:#252521;--line:#2E2E2A;--ink:#F2F1EC;--ink-2:#A9A79D;--link:#D4FF3A;
--ok:#5DD6B0;--ok-bg:#17302A;--warn:#F5B947;--warn-bg:#33280F;--warn-fill:#F5B947;--bad:#FF7A6E;--bad-bg:#3A1A17;--muted:#A9A79D;--muted-bg:#252521;--code-bg:#0E0E0D;--tab-on:#2A3010;--rail:#141413;color-scheme:dark}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--ground);color:var(--ink);font:400 15px/1.5 "Instrument Sans",system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
.mono,.meta,code,pre{font-family:"JetBrains Mono",ui-monospace,"SF Mono",Menlo,Consolas,monospace}
a{color:var(--link);text-decoration:none}a:hover{text-decoration:underline}
:focus-visible{outline:2px solid var(--ink);outline-offset:2px}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
.glyph{display:inline-block;width:10px;height:10px;flex:none;vertical-align:middle}
.tone-ok{--tone:var(--ok);--tone-bg:var(--ok-bg)}.tone-warn{--tone:var(--warn);--tone-bg:var(--warn-bg)}.tone-bad{--tone:var(--bad);--tone-bg:var(--bad-bg)}.tone-muted{--tone:var(--muted);--tone-bg:var(--muted-bg)}

header.top{background:var(--surface);border-bottom:1px solid var(--line)}
.top-in{max-width:1100px;margin:0 auto;padding:0 16px;display:flex;flex-wrap:wrap;align-items:center;gap:4px 24px}
.brand{display:flex;align-items:center;gap:8px;color:var(--ink);padding:12px 0;font-weight:600;font-size:17px}.brand:hover{text-decoration:none}.brand .who{color:var(--ink-2);font-weight:400;font-size:15px}
nav.tabs{display:flex;flex-wrap:wrap;gap:0 18px;flex:1 1 auto;align-items:center}
nav.tabs a{color:var(--ink-2);padding:12px 2px;border-bottom:2px solid transparent;font-size:14px}nav.tabs a:hover{color:var(--ink);text-decoration:none}
nav.tabs a[aria-current]{color:var(--ink);border-bottom-color:var(--ink);font-weight:600}
nav.tabs .sep{width:1px;height:18px;background:var(--line)}
.top-right{display:flex;align-items:center;gap:12px;font-size:13px;color:var(--ink-2)}.top-right a{color:var(--ink-2)}
form.inline{display:inline;margin:0}form.inline button{background:var(--raised);border:0;border-radius:var(--r-control);padding:6px 12px;color:var(--ink);font:inherit;font-size:13px;cursor:pointer}
@media (max-width:640px){.top-in{display:grid;grid-template-columns:1fr auto;grid-template-areas:"brand right" "tabs tabs";gap:0 12px}
.brand{grid-area:brand}.top-right{grid-area:right}.top-right .clock{display:none}
nav.tabs{grid-area:tabs;flex-wrap:nowrap;overflow-x:auto;scrollbar-width:none;white-space:nowrap;margin:0 -16px;padding:0 16px}nav.tabs::-webkit-scrollbar{display:none}}

main{max-width:1100px;margin:0 auto;padding:24px 16px 48px;display:flex;flex-direction:column;gap:16px}
h1{margin:0;font-size:28px;font-weight:600;letter-spacing:-.02em;line-height:1.2}
.intro{margin:6px 0 0;color:var(--ink-2);max-width:680px}
.label{font-size:13px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--ink-2)}
.flash{padding:12px 16px;border-radius:var(--r-card);background:var(--code-bg);color:var(--code-ink);display:flex;gap:10px;align-items:center}.flash .from{font-family:"JetBrains Mono",monospace;font-size:12px;opacity:.75}
.flash.bad{background:var(--bad-bg);color:var(--bad)}
.cols{display:flex;flex-wrap:wrap;gap:16px;align-items:flex-start}.main-col{flex:999 1 560px;min-width:0;display:flex;flex-direction:column;gap:16px}.side-col{flex:1 1 300px;min-width:0;display:flex;flex-direction:column;gap:16px}

.card{background:var(--surface);border-radius:var(--r-card);padding:14px 16px;min-width:0}
.card>h2{margin:0 0 10px;font-size:16px;font-weight:600}.card h3{margin:0 0 8px;font-size:15px;font-weight:600}
.card>*+*{margin-top:12px}
.card.toned{padding-top:0}.card .band{margin:0 -16px 12px;padding:12px 16px;background:var(--tone-bg);color:var(--ink);border-radius:var(--r-card) var(--r-card) 0 0;display:flex;justify-content:space-between;align-items:center;gap:12px}
.card .band h2{margin:0;font-size:16px;font-weight:600}.card .band .tone-word{color:var(--tone);font-weight:600;font-size:13px;display:inline-flex;align-items:center;gap:6px}

.stats{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin:0}.stats:has(>.stat:nth-child(3):last-child){grid-template-columns:repeat(3,minmax(0,1fr))}
.stats.strip{display:flex;overflow-x:auto;scroll-snap-type:x mandatory;scrollbar-width:none;margin:0 -16px;padding:0 16px}.stats.strip::-webkit-scrollbar{display:none}.stats.strip .stat{flex:0 0 46%;scroll-snap-align:start}
@media (min-width:720px){.stats,.stats.strip{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));overflow:visible;margin:0;padding:0}}
.stat{position:relative;background:var(--ground);border-radius:12px;padding:12px 14px;min-height:88px;display:flex;flex-direction:column;gap:2px;min-width:0}
.card .stat{background:var(--raised)}
.stat dt{font-size:13px;color:var(--ink-2)}.stat dd{margin:0}.stat .value{font-size:28px;font-weight:600;letter-spacing:-.02em;line-height:1.15;font-variant-numeric:tabular-nums;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.stat .value.long{font-size:19px;line-height:1.25;white-space:normal;overflow-wrap:anywhere}
.stat .detail{font-size:12px;color:var(--ink-2)}.stat[class*=tone-] .value{color:var(--tone)}.stat .glyph{position:absolute;top:12px;right:12px}
.stats.one,.stats.one.strip{display:grid;grid-template-columns:1fr}.stats.one .stat{min-height:0;padding:16px 18px;gap:4px}
.stats.one .value{font-size:56px;letter-spacing:-.045em;line-height:1}.stats.one .value.long{font-size:34px;letter-spacing:-.03em;line-height:1.1;white-space:normal}.stats.one .detail{font-size:15px}
a.stat-link{position:absolute;inset:0;border-radius:inherit}a.stat-link:hover{background:rgba(127,127,127,.06)}

.list{list-style:none;margin:0 -16px;padding:0}
.list li{display:flex;align-items:center;gap:12px;padding:12px 16px;min-height:56px;border-bottom:1px solid var(--raised)}.list li:last-child{border-bottom:0}
.list .body{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}.list .text{font-size:15px;overflow-wrap:anywhere}.list .meta{font-size:11px;color:var(--ink-2)}
.list li a.row-link{color:inherit}.list li a.row-link::after{content:"";position:absolute;inset:0}.list li:has(a.row-link){position:relative}.list li:has(a.row-link):hover{background:rgba(127,127,127,.05)}
.list li[class*=tone-] .text{color:var(--ink)}
.badge{font-size:12px;color:var(--ink-2);background:var(--raised);border-radius:6px;padding:2px 8px;white-space:nowrap;flex:none}
.empty{color:var(--ink-2);font-size:14px;margin:0}

.table-wrap{overflow-x:auto}.table-wrap table{border-collapse:collapse;width:100%;font-size:14px}
.table-wrap th,.table-wrap td{text-align:left;padding:10px 12px 10px 0;border-bottom:1px solid var(--raised);vertical-align:top}
.table-wrap th{color:var(--ink-2);font-weight:600;font-size:12px;letter-spacing:.04em;text-transform:uppercase;position:sticky;top:0;background:var(--surface)}
.table-cards{display:none;flex-direction:column}
.trow{display:flex;align-items:flex-start;gap:12px;padding:12px 0;border-bottom:1px solid var(--line)}.trow:last-child{border-bottom:0}
.tmain{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px}.ttitle{font-size:15px;font-weight:500;overflow-wrap:anywhere}
.tline{font-size:13px;color:var(--ink);overflow-wrap:anywhere}.tline .tl{color:var(--ink-2)}.tline .tdot{color:var(--ink-2)}
.tside{flex:none;max-width:45%;text-align:right;font-size:14px;color:var(--ink-2);overflow-wrap:anywhere}
.trow dl{margin:6px 0 0;display:grid;grid-template-columns:minmax(80px,40%) 1fr;gap:4px 12px;font-size:13px}.trow dt{color:var(--ink-2)}.trow dd{margin:0;overflow-wrap:anywhere}
.trow details summary{color:var(--link);font-size:13px;cursor:pointer;list-style:none;width:max-content}.trow details summary::-webkit-details-marker{display:none}
@media (max-width:640px){.table-wrap{display:none}.table-cards{display:flex}}

.kv{margin:0;display:flex;flex-direction:column}
.kv>div{display:flex;justify-content:space-between;gap:16px;padding:10px 0;border-bottom:1px solid var(--raised);font-size:15px}.kv>div:last-child{border-bottom:0}
.kv dt{color:var(--ink-2)}.kv dd{margin:0;text-align:right;overflow-wrap:anywhere}.kv>div.long{flex-direction:column;gap:2px}.kv>div.long dd{text-align:left}

.text-block{margin:0;font-size:15px;line-height:1.5;white-space:pre-line;overflow-wrap:anywhere}
.text-block[class*=tone-]{display:flex;gap:8px;color:var(--tone)}.text-block[class*=tone-] .glyph{margin-top:.45em}
.text-block.tone-muted{color:var(--ink-2);font-size:14px}
.clamp{display:-webkit-box;-webkit-line-clamp:6;-webkit-box-orient:vertical;overflow:hidden}.clamp.open{display:block}
.more{background:none;border:0;padding:0;font:inherit;font-size:14px;color:var(--link);cursor:pointer}

.callout{padding:14px 16px;border-radius:12px;background:var(--raised);display:flex;gap:10px}
.callout[class*=tone-]:not(.tone-muted){background:var(--tone-bg);color:var(--tone)}.callout .glyph{margin-top:.45em}
.callout strong{display:block;font-weight:600}.callout p{margin:2px 0 0}

.link-row{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:52px;padding:0 16px;margin:0 -16px;color:var(--ink);font-size:15px}
.link-row:hover{text-decoration:none;background:rgba(127,127,127,.05)}.link-row .domain{display:block;font-size:11px;color:var(--ink-2)}.link-row .arrow{color:var(--ink-2);flex:none}

.filters{display:flex;gap:8px;overflow-x:auto;scrollbar-width:none;margin:0 -16px;padding:2px 16px}.filters::-webkit-scrollbar{display:none}
@media (min-width:720px){.filters{flex-wrap:wrap;overflow:visible;margin:0;padding:0}}
.pill{flex:none;display:inline-flex;align-items:center;height:40px;padding:0 16px;border-radius:999px;background:var(--surface);color:var(--ink);font-size:14px;border:1px solid var(--line)}.pill:hover{text-decoration:none;border-color:var(--ink-2)}
.pill.on{background:var(--ink);border-color:var(--ink);color:var(--ground);font-weight:600}

details.details{border-bottom:1px solid var(--raised);margin:0 -16px}details.details:last-child{border-bottom:0}
details.details>summary{cursor:pointer;display:flex;align-items:center;gap:12px;padding:12px 16px;min-height:56px;list-style:none}details.details>summary::-webkit-details-marker{display:none}
details.details>summary .body{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}details.details>summary .meta{font-size:11px;color:var(--ink-2)}
details.details>summary .chev{color:var(--ink-2);transition:transform .12s}details.details[open]>summary .chev{transform:rotate(90deg)}
.details-body{padding:0 16px 16px;display:flex;flex-direction:column;gap:12px}

.btn{font:inherit;font-size:15px;font-weight:600;height:48px;padding:0 18px;border-radius:var(--r-button);border:0;background:var(--raised);color:var(--ink);cursor:pointer;transition:transform .12s}.btn:active{transform:scale(.98)}
.btn.primary{background:var(--thread);color:#161614}.btn.danger{background:transparent;color:var(--bad);border:1px solid var(--bad)}
.buttons{display:flex;flex-wrap:wrap;gap:8px}.buttons .button-form{margin:0;flex:1 1 140px;display:flex}.buttons .button-form .btn{flex:1}
.buttons.wide .button-form{flex-basis:100%}

.piece-form{display:flex;flex-direction:column;gap:16px;margin:0}
.field{display:flex;flex-direction:column;gap:6px;border:0;padding:0;margin:0;min-width:0}.field>label,.field>legend{font-size:13px;font-weight:600;color:var(--ink-2);padding:0}
.field input[type=text],.field input[type=password],.field textarea,.field select{font:inherit;font-size:16px;height:48px;padding:0 12px;border:1px solid var(--line);border-radius:var(--r-control);background:var(--ground);color:var(--ink);width:100%}
.field textarea{height:auto;min-height:96px;padding:10px 12px;line-height:1.45}
.hint{font-size:12px;color:var(--ink-2);font-weight:400}.note{margin:0;font-size:13px;color:var(--ink-2)}
.actions{display:flex;gap:8px}.actions .btn{flex:1}
.segmented{display:flex;gap:2px;padding:3px;border-radius:10px;background:var(--raised)}
.segmented label{flex:1;position:relative}.segmented input{position:absolute;opacity:0;inset:0;margin:0;cursor:pointer}
.segmented span{display:flex;align-items:center;justify-content:center;height:42px;border-radius:var(--r-control);font-size:14px;color:var(--ink-2)}
.segmented input:checked+span{background:var(--surface);color:var(--ink);font-weight:600}.segmented input:focus-visible+span{outline:2px solid var(--ink)}
.choice .option{display:flex;gap:10px;align-items:flex-start;padding:12px;border:1px solid var(--line);border-radius:var(--r-control);background:var(--ground);margin-top:6px;cursor:pointer}.choice .option span{display:flex;flex-direction:column;gap:2px}

.meters{display:flex;flex-direction:column;gap:14px}.meter-head{display:flex;justify-content:space-between;align-items:baseline;gap:8px;font-size:15px}
.meter-head .pct{font-variant-numeric:tabular-nums;display:inline-flex;align-items:center;gap:6px}.meter[class*=tone-]:not(.tone-ok) .pct{color:var(--tone);font-weight:600}
.bar{height:10px;border-radius:999px;background:var(--raised);overflow:hidden;margin:6px 0 4px}.bar span{display:block;height:100%;border-radius:999px;background:var(--ink)}
.meter.tone-warn .bar span{background:var(--warn-fill)}.meter.tone-bad .bar span{background:var(--bad)}.meter.tone-muted .bar span{background:var(--ink-2)}
.meter .meta{font-size:11px;color:var(--ink-2)}

.code-block{background:var(--code-bg);color:var(--code-ink);border-radius:var(--r-card);padding:14px 16px;display:grid;grid-template-columns:1fr auto;gap:10px 12px;align-items:center}
.code-block .meta{color:#A9A79D;font-family:inherit;font-size:13px}.code-block pre{grid-column:1/-1;margin:0;font-size:13px;white-space:pre-wrap;word-break:break-all;color:var(--code-ink)}
.code-block .copy{grid-column:2;grid-row:1;height:36px;padding:0 12px;font-size:14px;background:var(--thread);color:#161614;border-radius:var(--r-control)}
.code-block.nolabel .copy{grid-row:auto;grid-column:2}

ul.status{list-style:none;margin:0 -16px;padding:0}
ul.status li{display:flex;align-items:center;gap:12px;padding:12px 16px;min-height:56px;border-bottom:1px solid var(--raised)}ul.status li:last-child{border-bottom:0}
ul.status .body{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}ul.status .label{font-size:15px;text-transform:none;letter-spacing:0;font-weight:500;color:var(--ink)}
ul.status .text{font-size:13px;color:var(--tone,var(--ink-2))}ul.status .meta{font-size:11px;color:var(--ink-2);flex:none}

.tiles{display:flex;gap:10px;overflow-x:auto;scroll-snap-type:x mandatory;scrollbar-width:none;margin:0 -16px;padding:0 16px}.tiles::-webkit-scrollbar{display:none}
@media (min-width:720px){.tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));overflow:visible;margin:0;padding:0}}
.tile{position:relative;flex:0 0 46%;scroll-snap-align:start;background:var(--surface);border-radius:var(--r-card);padding:14px;min-height:88px;color:var(--ink);display:flex;flex-direction:column;gap:2px}a.tile:hover{text-decoration:none;background:var(--raised)}
.tile .eyebrow{font-size:13px;color:var(--ink-2)}.tile .value{font-size:28px;font-weight:600;letter-spacing:-.02em;line-height:1.15}.tile .detail{font-size:12px;color:var(--ink-2)}
.tile[class*=tone-] .value{color:var(--tone)}.tile .glyph{position:absolute;top:14px;right:14px}

.ask-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:10px}
.ask{background:var(--surface);border-radius:var(--r-card);padding:14px 16px;display:flex;flex-direction:column;gap:6px;border:1px solid var(--line)}
.ask .sentence{font-size:14px;color:var(--ink-2)}.ask .src{display:flex;justify-content:space-between;font-size:13px;color:var(--ink-2)}.ask .text{font-size:16px;font-weight:500}
.ask:target,.ask:focus{outline:2px solid var(--thread);outline-offset:2px}.ask .go{align-self:flex-start;display:inline-flex;align-items:center;height:44px;padding:0 18px;border-radius:var(--r-button);background:var(--thread);color:#161614;font-weight:600}.ask .go:hover{text-decoration:none}
.your-call .label{color:var(--link)}

footer{max-width:1100px;margin:0 auto;padding:0 16px 32px;color:var(--ink-2);font-size:12px;display:flex;flex-wrap:wrap;gap:6px 14px}
.login{max-width:400px;margin:0 auto;padding:72px 20px 24px;display:flex;flex-direction:column;gap:12px}
.login h1{font-size:40px;letter-spacing:-.035em}
.login input{width:100%;height:56px;padding:0 14px;border:1px solid var(--line);border-radius:var(--r-button);background:var(--surface);color:var(--ink);font:inherit;font-size:16px}
.login button{height:56px;border:0;border-radius:var(--r-button);background:var(--thread);color:#161614;font:inherit;font-size:16px;font-weight:600;cursor:pointer}
.login button.secondary{background:var(--raised);color:var(--ink)}
.err{color:var(--bad)}.sub{color:var(--ink-2);margin:0}

.app{display:flex;min-height:100vh}.content{flex:1;min-width:0;display:flex;flex-direction:column}.content>main{min-width:0;width:100%}
.mark{display:inline-flex;align-items:center;justify-content:center;border-radius:27%;font-weight:700;flex:none;line-height:1}
.hmark{flex:none}
.wordmark{display:inline-flex;align-items:center;gap:8px;font-size:20px;font-weight:600;color:var(--ink);letter-spacing:-.01em}.wordmark:hover{text-decoration:none}
.rail{display:none}
.phone-top{position:sticky;top:0;z-index:15;display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:56px;padding:calc(6px + env(safe-area-inset-top)) 16px 6px;background:var(--ground)}
.scope-pill{flex:none;display:inline-flex;align-items:center;gap:8px;max-width:60%;height:40px;padding:0 12px 0 6px;border-radius:999px;background:var(--surface);border:1px solid var(--line);color:var(--ink);font-weight:600;font-size:14px}.scope-pill:hover{text-decoration:none}
.scope-pill span:not(.caret){overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.scope-pill .caret{color:var(--ink-2)}
.back{width:44px;height:44px;margin-left:-10px;display:inline-flex;align-items:center;justify-content:center;border-radius:999px;color:var(--ink)}.back:hover{background:var(--raised)}
.bottom{position:fixed;left:0;right:0;bottom:0;z-index:20;display:flex;gap:6px;align-items:center;padding:8px 12px calc(8px + env(safe-area-inset-bottom));background:var(--surface);border-top:1px solid var(--line)}
.bottom .tab{flex:1;height:48px;display:flex;align-items:center;justify-content:center;border-radius:14px;color:var(--ink-2)}.bottom .tab:hover{text-decoration:none;color:var(--ink)}
.bottom .tab.on{background:var(--tab-on);color:var(--thread)}
.content{padding-bottom:84px}
@media (min-width:960px){
.rail{display:flex;flex-direction:column;gap:14px;flex:0 0 248px;padding:24px 16px;background:var(--rail);min-height:100vh}
.bottom,.phone-top{display:none}.content{padding-bottom:0}
main{padding:40px 40px 48px;max-width:1180px;margin:0}footer{margin:0;padding:0 40px 32px}}
.scope-btn{display:flex;align-items:center;gap:10px;background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:10px 12px;color:var(--ink)}.scope-btn:hover{text-decoration:none;border-color:var(--ink-2)}
.scope-btn .body,.scope-row .body{flex:1;min-width:0;display:flex;flex-direction:column}.scope-btn .text,.scope-row .text{font-weight:600;font-size:15px}
.scope-btn .sub,.scope-row .sub{font-size:12px;color:var(--ink-2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.find-btn{display:flex;align-items:center;gap:8px;background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:0 12px;height:40px;color:var(--ink-2);font-size:14px}.find-btn:hover{text-decoration:none;color:var(--ink)}
.find-btn span{flex:1}.find-btn kbd{font-family:"JetBrains Mono",monospace;font-size:11px;border:1px solid var(--line);border-radius:6px;padding:1px 5px}
.rail-nav{display:flex;flex-direction:column;gap:2px}
.rail-link{display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:42px;padding:0 12px;border-radius:10px;color:var(--ink);font-size:15px}.rail-link:hover{text-decoration:none;background:var(--surface)}
.rail-link.on{background:var(--ink);color:var(--ground)}.rail-link.quiet{color:var(--ink-2);font-size:14px}
.count{display:inline-flex;align-items:center;justify-content:center;min-width:24px;height:24px;padding:0 7px;border-radius:999px;background:var(--thread);color:#161614;font-size:13px;font-weight:600}
.rail-label{margin:16px 12px 4px;font-size:12px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--ink-2)}
.rail-foot{margin-top:auto;padding-top:16px;border-top:1px solid var(--line);display:flex;align-items:center;gap:14px;font-size:14px;color:var(--ink)}.rail-foot a{color:var(--ink)}
.rail-foot form.inline button{background:none;padding:0;font-size:14px}
dialog.sheet{position:fixed;inset:auto 0 0 0;margin:0 auto;width:100%;max-width:520px;max-height:86vh;overflow:auto;border:0;border-radius:var(--r-sheet) var(--r-sheet) 0 0;background:var(--surface);color:var(--ink);padding:6px 16px calc(16px + env(safe-area-inset-bottom))}
dialog.sheet::backdrop{background:rgba(14,14,13,.45)}
dialog.sheet[open]{animation:sheet-up .22s ease-out}@keyframes sheet-up{from{transform:translateY(32px);opacity:.4}to{transform:none;opacity:1}}
@media (prefers-reduced-motion:reduce){dialog.sheet[open]{animation:sheet-fade .22s ease-out}@keyframes sheet-fade{from{opacity:0}}}
@media (min-width:960px){dialog.sheet{inset:0;margin:auto;height:fit-content;border-radius:var(--r-sheet);padding:12px 20px 20px}}
.sheet-grip{width:40px;height:4px;border-radius:2px;background:var(--line);margin:4px auto 10px}
.sheet-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px}.sheet-head h2{margin:0;font-size:20px;font-weight:600}
.sheet-close{width:40px;height:40px;border:0;border-radius:999px;background:var(--raised);color:var(--ink);display:flex;align-items:center;justify-content:center;cursor:pointer}
.sheet-rows{display:flex;flex-direction:column;gap:8px}
.scope-row{display:flex;align-items:center;gap:12px;min-height:60px;padding:12px;border-radius:var(--r-card);background:var(--ground);color:var(--ink)}.scope-row:hover{text-decoration:none}
.scope-row.on{background:var(--ink);color:var(--ground)}.scope-row.on .sub{color:var(--line)}
.scope-row.new{background:transparent;border:1px dashed var(--line)}.plusbox{width:32px;height:32px;border:1px dashed var(--ink-2);border-radius:9px;display:inline-flex;align-items:center;justify-content:center}
.sheet-foot{display:flex;align-items:center;gap:8px;margin-top:16px;padding-top:12px;border-top:1px solid var(--line)}.sheet-foot .owner{flex:1}
.btn.small,form.small button{height:40px;padding:0 14px;font-size:14px;font-weight:500;border-radius:var(--r-button);background:var(--raised);border:0;color:var(--ink);display:inline-flex;align-items:center}.btn.small:hover{text-decoration:none}
form.small button{background:transparent}
.place-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}
.place{display:flex;flex-direction:column;min-height:92px;padding:12px;border-radius:var(--r-card);background:var(--ground);color:var(--ink)}.place:hover{text-decoration:none;outline:1px solid var(--line)}
.place.on{outline:2px solid var(--ink)}.pl-top{height:12px}.pl-label{margin-top:auto;font-weight:600;font-size:14px}.pl-stat{font-size:12px;color:var(--ink-2)}.place[class*=tone-]:not(.tone-ok) .pl-stat{color:var(--tone)}
.place-rows{margin-top:10px;padding:0 16px}
main.sheet-page{max-width:560px}.sheet-page h1{margin-bottom:8px}
.visually-hidden{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.find-form{display:flex;align-items:center;gap:12px}.find-form input{flex:1;min-width:0}
.find-cancel{font-size:15px;font-weight:600;color:var(--ink);white-space:nowrap}
.find-form input::-webkit-search-cancel-button{-webkit-appearance:none;appearance:none}
.find-results .card.rows{background:var(--raised);padding:0 14px}
.find-results{display:flex;flex-direction:column;gap:20px;margin-top:18px}.find-group .label{margin:0 0 8px}
.find-row{display:flex;align-items:center;gap:12px;min-height:52px;padding:6px 0;border-bottom:1px solid var(--line);color:var(--ink);font-size:15px;line-height:1.35}.find-row:last-child{border-bottom:0}
.find-row:hover,.find-row:focus-visible{text-decoration:none;outline:0}.find-row:focus-visible .ft{text-decoration:underline;text-decoration-color:var(--thread);text-decoration-thickness:2px;text-underline-offset:3px}
.find-row strong{font-weight:700}.find-row .mark{flex:none}
.do-dot{flex:none;width:8px;height:8px;border-radius:50%;background:var(--thread);box-shadow:0 0 0 1px rgba(22,22,20,.25)}
dialog.find-sheet{inset:0;margin:0;width:100%;max-width:none;height:100%;max-height:none;border-radius:0;padding:14px 16px calc(16px + env(safe-area-inset-bottom))}
.find-form input{width:100%;height:52px;padding:0 16px;border:1px solid var(--line);border-radius:var(--r-button);background:var(--surface);color:var(--ink);font:inherit;font-size:16px}
.unscoped{display:flex;align-items:center;gap:12px;margin:0;padding:12px 14px;border-radius:var(--r-card);background:var(--raised);color:var(--ink);font-size:14px;line-height:1.4}
.list li>.mark{align-self:flex-start;margin-top:2px}

main.dash{gap:24px}
.dash-head{display:flex;flex-direction:column;gap:2px}.dash-head .display{font-size:40px;font-weight:600;letter-spacing:-.035em;line-height:1.1;margin:2px 0 0}
.dash-head .sub{font-size:15px}
.dash-head.agent{flex-direction:row;align-items:center;gap:14px}.dash-head.agent h1{font-size:24px}
.seg-tabs{display:flex;gap:2px;padding:3px;border-radius:12px;background:var(--raised)}
.seg-tabs a{flex:1;display:flex;align-items:center;justify-content:center;height:42px;border-radius:var(--r-control);color:var(--ink-2);font-size:14px}.seg-tabs a:hover{text-decoration:none;color:var(--ink)}
.seg-tabs a.on{background:var(--surface);color:var(--ink);font-weight:600}
.your-call .label .n{float:right;color:var(--ink-2)}
.list .avatar{flex:none;width:36px;height:36px;border-radius:50%;background:var(--raised);color:var(--ink);display:inline-flex;align-items:center;justify-content:center;font-weight:600;font-size:13px;letter-spacing:.02em}
.link-row .body{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}.link-row .body .meta{font-size:12px;color:var(--ink-2);font-family:inherit}.link-row .glyph{margin-right:6px}#sheet-setup .card.rows+.card.rows{margin-top:10px}
[id$="--history"] .list li{position:relative;padding-left:22px}[id$="--history"] .list li::before{content:"";position:absolute;left:4px;top:18px;width:9px;height:9px;border-radius:50%;border:1.5px solid var(--ink-2);background:var(--surface)}
[id$="--history"] .list li:not(:first-child) .text{color:var(--ink-2)}[id$="--history"] .list li:first-child::before{background:var(--ink);border-color:var(--ink)}[id$="--history"] .list li:not(:last-child)::after{content:"";position:absolute;left:8.5px;top:29px;bottom:-10px;width:1.5px;background:var(--line)}
.prose{font-size:16px;line-height:1.55;overflow-wrap:anywhere}.prose>*{margin:0 0 12px}.prose>*:last-child{margin-bottom:0}
.prose h3{font-size:19px;margin-top:20px}.prose h4{font-size:16px;margin-top:16px}.prose h5{font-size:14px;margin-top:14px;text-transform:uppercase;letter-spacing:.04em;color:var(--ink-2)}
.prose table{border-collapse:collapse;width:100%;font-size:14px;display:block;overflow-x:auto}.prose th,.prose td{text-align:left;padding:6px 10px 6px 0;border-bottom:1px solid var(--line)}.prose hr{border:0;border-top:1px solid var(--line)}
.prose ul,.prose ol{padding-left:22px}.prose li{margin:4px 0}.prose blockquote{margin-left:0;padding-left:12px;border-left:3px solid var(--line);color:var(--ink-2)}
.prose code{font-family:"JetBrains Mono",ui-monospace,monospace;font-size:.88em;padding:1px 5px;border-radius:5px;background:var(--raised)}
.prose pre{padding:12px 14px;border-radius:10px;background:var(--code-bg);color:var(--code-ink);overflow-x:auto;font-size:13px}.prose pre code{background:none;padding:0;color:inherit}
.filter-search{margin:0 0 10px}.filter-search input{width:100%;height:48px;padding:0 14px;border:1px solid var(--line);border-radius:var(--r-button);background:var(--surface);color:var(--ink);font:inherit;font-size:16px}.filter-search input::-webkit-search-cancel-button{-webkit-appearance:none;appearance:none}
.back.named{width:auto;height:44px;padding:0 10px 0 4px;margin-left:-8px;display:inline-flex;align-items:center;gap:2px;font-size:15px;font-weight:600;color:var(--ink)}.back.named:hover{text-decoration:none}
.place-core{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:10px}.place-btn{display:flex;align-items:center;height:52px;padding:0 14px;border:1px solid var(--line);border-radius:var(--r-card);color:var(--ink);font-weight:600;font-size:15px}.place-btn:hover{text-decoration:none;background:var(--raised)}.place-btn.on{border-color:var(--ink)}
.manage-link{display:block;text-align:center;margin:14px 0 2px;padding:10px;font-weight:600;font-size:15px;color:var(--link)}
.list .meta,details.details>summary .meta{font-family:inherit;font-size:12px}
.details-sheet .sub{margin:0 0 12px;font-size:12px;color:var(--ink-2)}.details-sheet .sheet-body{display:flex;flex-direction:column;gap:12px;padding-bottom:4px}
.starters .label{margin:0 0 10px}.starter{display:flex;align-items:center;gap:12px;padding:12px 0;border-bottom:1px solid var(--line)}.starter:last-child{border-bottom:0}
.starter .body{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}.starter .text{font-weight:600}.starter .meta{font-family:inherit;font-size:13px;color:var(--ink-2)}.starter .button-form{margin:0}
.empty-state{margin:0;padding:20px 16px;border-radius:var(--r-card);background:var(--surface);color:var(--ink-2)}
.buttons+.piece-form{margin-top:18px}
.ask .src{align-items:center}.ask .who{display:inline-flex;align-items:center;gap:8px}
.ask[class*=tone-]{border-color:color-mix(in srgb,var(--tone) 45%,var(--line))}
.ask .go{margin-top:6px;height:48px;padding:0 20px}
.ask .text{font-size:18px;font-weight:600;letter-spacing:-.01em;line-height:1.3;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.more-asks{margin-top:10px}.more-asks>summary{list-style:none;cursor:pointer;display:flex;align-items:center;justify-content:center;min-height:44px;border-radius:var(--r-button);border:1px solid var(--line);color:var(--ink-2);font-weight:600}.more-asks>summary::-webkit-details-marker{display:none}.more-asks[open]>summary{margin-bottom:10px}
.dash-cols{display:flex;flex-direction:column;gap:24px}.dash-main,.dash-side{display:flex;flex-direction:column;gap:24px;min-width:0}
.dash-side .glance{display:none}
.glance .label,.thread .label,.shared .label{margin:0 0 10px}
.thread{display:flex;flex-direction:column}.thread .filters{margin-bottom:10px}
.thread-list{margin:0;background:transparent}.thread-list li{padding:12px 0;align-items:flex-start;border-bottom:1px solid var(--line)}
.thread-list li .mark{margin-top:1px}.thread-list .text{font-size:15px}.thread-list .meta{font-size:12px;font-family:inherit}
.thread-list .new{width:8px;height:8px;border-radius:50%;background:var(--thread);flex:none;align-self:center;box-shadow:0 0 0 1px rgba(22,22,20,.25)}
.thread-list li.seen{border:0;padding:6px 0;justify-content:center;font-size:13px;color:var(--ink-2);gap:12px;min-height:0}
.thread-list li.seen::before,.thread-list li.seen::after{content:"";flex:1;height:1px;background:var(--line)}
.more-link{margin-top:12px;font-size:15px}
.dash.today .tiles{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;overflow:visible;margin:0;padding:0}.dash.today .tile{min-width:0}
.shared .rows{padding:0 16px}.shared .domain{font-family:inherit;font-size:12px}
.toasts{position:fixed;left:16px;right:16px;bottom:calc(84px + env(safe-area-inset-bottom));z-index:40;display:flex;flex-direction:column;align-items:center;gap:8px;pointer-events:none}
.toasts:not(:has(.toast)){display:none}
.toast{pointer-events:auto;width:100%;max-width:520px;border:1px solid var(--line);box-shadow:0 8px 24px rgba(0,0,0,.18);animation:toast-in .18s ease-out}.toast.out{opacity:0;transform:translateY(8px);transition:opacity .25s,transform .25s}
.toast-close{border:0;background:transparent;color:inherit;font-size:20px;line-height:1;padding:0 2px;cursor:pointer;opacity:.7}.toast.keep .tm{word-break:break-all;user-select:all}
.toast .tg{font-size:11px}.flash form.undo{margin:0 0 0 auto}.undo-btn{border:0;background:transparent;color:var(--thread);font:inherit;font-weight:700;cursor:pointer;padding:4px 6px}.flash.bad .undo-btn{color:inherit}.toast.ok .tg{color:var(--thread)}.toast .tm{flex:1}
@keyframes toast-in{from{opacity:0;transform:translateY(8px)}}
.btn.busy{position:relative;color:transparent!important}.btn.busy::after{content:"";position:absolute;inset:0;margin:auto;width:16px;height:16px;border-radius:50%;border:2px solid var(--ink-2);border-right-color:transparent;animation:spin .7s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.ask.fold{opacity:.45;transition:opacity .2s}
dialog.confirm .sub{margin:4px 0 0;font-size:15px;color:var(--ink-2)}
.confirm-actions{display:flex;flex-direction:column;gap:8px;margin-top:20px}.confirm-actions .btn{width:100%;height:52px}
.confirm-actions .btn.danger{background:var(--bad);color:var(--surface);border:0}
.new-pill{align-self:center;margin:0 0 10px;height:36px;padding:0 16px;border:0;border-radius:999px;background:var(--ink);color:var(--ground);font:inherit;font-size:14px;font-weight:600;cursor:pointer}
[data-live-status].off{color:var(--bad)}
@media (prefers-reduced-motion:reduce){.toast,.toast.out,.btn.busy::after{animation:none;transition:none}}
.offline-banner{border:1px solid var(--line);display:flex;align-items:flex-start;gap:10px;padding:12px 14px;border-radius:12px;background:#161614;color:#F4F3EE;font-size:14px;line-height:1.4}
.offline-banner .ob-words{display:flex;flex-direction:column;gap:2px}.offline-banner strong{font-weight:600}.offline-banner .ob-words span{color:#C9C7BE}
.ob-clock{flex:none;width:18px;height:18px;margin-top:1px;border:1.6px solid #F5B947;border-radius:50%;position:relative}.ob-clock::after{content:"";position:absolute;left:7px;top:3px;width:4px;height:5px;border-left:1.6px solid #F5B947;border-bottom:1.6px solid #F5B947}
.offline [class*=tone-]{--tone:var(--muted);--tone-bg:var(--muted-bg)}
.offline svg.glyph *{fill:none;stroke:currentColor;stroke-width:1.5}
.offline .new{background:transparent;box-shadow:inset 0 0 0 1.5px var(--ink-2)}
a.needs-net{pointer-events:auto;text-decoration:none}.btn.needs-net,.needs-net{background:var(--raised)!important;color:var(--ink-2)!important;border:1px dashed var(--line)!important;cursor:not-allowed}
@media (min-width:960px){
.seg-tabs{max-width:520px}
.starters{max-width:640px}
dialog.find-sheet{inset:12vh 0 auto 0;margin:0 auto;width:640px;height:auto;max-height:72vh;border-radius:var(--r-sheet);padding:16px 20px 20px}
.toasts{left:auto;right:24px;bottom:24px;width:400px;align-items:stretch}
.your-call .ask-list{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px}
.dash-cols{display:grid;grid-template-columns:minmax(0,1fr) 300px;align-items:start;gap:28px}
.glance-phone{display:none}.dash-side .glance{display:block}
.dash-side .tiles{display:grid;grid-template-columns:1fr 1fr;gap:10px}.dash-side .tile{min-height:96px}
.thread-list{background:var(--surface);border-radius:var(--r-card);padding:4px 16px}.thread-list li:last-child{border-bottom:0}}
`;
