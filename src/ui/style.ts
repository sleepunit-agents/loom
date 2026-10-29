/**
 * The sign-in pages' stylesheet (the only pages loom still writes as HTML; every other page is the app, web/):
 * Claude Design's foundations (2026-10-26 handoff, Art notes/design/2026-10-26-loom-page/HANDOFF.md) as custom
 * properties, light and dark from prefers-color-scheme. Fonts are loom's own (/fonts/, OFL).
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
.login{max-width:400px;margin:0 auto;padding:72px 20px 24px;display:flex;flex-direction:column;gap:12px}
.login h1{font-size:40px;letter-spacing:-.035em}
.login input{width:100%;height:56px;padding:0 14px;border:1px solid var(--line);border-radius:var(--r-button);background:var(--surface);color:var(--ink);font:inherit;font-size:16px}
.login button{height:56px;border:0;border-radius:var(--r-button);background:var(--thread);color:#161614;font:inherit;font-size:16px;font-weight:600;cursor:pointer}
.login button.secondary{background:var(--raised);color:var(--ink)}
.signin{min-height:100vh;min-height:100dvh;max-width:400px;margin:0 auto;padding:24px 20px calc(24px + env(safe-area-inset-bottom));box-sizing:border-box;display:flex;flex-direction:column}
.signin-mark{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px}.signin-mark span{font-size:44px;font-weight:600;letter-spacing:-.04em}
.signin-bottom{display:flex;flex-direction:column;gap:12px;margin:0}.signin-bottom .pk{height:56px;border:0;border-radius:var(--r-button);background:var(--thread);color:#161614;font:inherit;font-size:17px;font-weight:600;display:flex;align-items:center;justify-content:center;gap:10px;cursor:pointer}
.signin-bottom #passkey-msg:empty{display:none}.signin .or{display:flex;align-items:center;gap:12px;color:var(--ink-2);font-size:13px}.signin .or::before,.signin .or::after{content:"";flex:1;border-top:1px solid var(--line)}
.token-row{display:flex;gap:8px}.token-row input{flex:1;min-width:0;height:52px;padding:0 14px;border:1px solid var(--line);border-radius:var(--r-button);background:var(--surface);color:var(--ink);font:inherit;font-size:16px}
.token-row button{height:52px;padding:0 18px;border:0;border-radius:var(--r-button);background:var(--ink);color:var(--surface);font:inherit;font-weight:600;cursor:pointer}.signin .hint{text-align:center;font-size:13px}
.err{color:var(--bad)}.sub{color:var(--ink-2);margin:0}
.logo{display:block;flex:none;border-radius:22%}.signin-mark .logo{border-radius:22%}
`;
