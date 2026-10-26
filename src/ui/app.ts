/**
 * loom's own page script, served at /app.js and loaded on every page
 * (script-src 'self'; never inline, and pieces can't add script: their pages
 * are data). Today: the Copy button on a code block (Select where the
 * clipboard needs https), and More on a long text block.
 */
export const APP_JS = `'use strict';
document.addEventListener('click', (e) => {
  const b = e.target instanceof Element ? e.target.closest('[data-copy]') : null;
  const code = b && b.parentElement ? b.parentElement.querySelector('pre code') : null;
  if (!code) return;
  const done = () => { const t = b.textContent; b.textContent = 'Copied'; setTimeout(() => { b.textContent = t; }, 1500); };
  // The clipboard API needs a secure context; on plain http, select the text for a copy by hand.
  if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(code.textContent).then(done, () => {});
  else { const r = document.createRange(); r.selectNodeContents(code); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }
});
document.addEventListener('DOMContentLoaded', () => {
  if (!(navigator.clipboard && window.isSecureContext)) for (const b of document.querySelectorAll('[data-copy]')) b.textContent = 'Select';
  // A text block clamped at six lines gets More, only when it really overflows.
  for (const t of document.querySelectorAll('[data-clamp]')) {
    const more = t.parentElement && t.parentElement.nextElementSibling;
    if (!more || !more.hasAttribute('data-more')) continue;
    if (t.scrollHeight > t.clientHeight + 2) more.hidden = false;
    more.addEventListener('click', () => { t.classList.add('open'); more.hidden = true; });
  }
});
`;
