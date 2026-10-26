/**
 * loom's own page script, served at /app.js and loaded on every page
 * (script-src 'self'; never inline, and pieces can't add script: their pages
 * are data). The shell's sheets (scope, Places), Cmd/Ctrl-K for Find; the Copy button on a code block (Select where the
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
// The shell's sheets: a link marked data-sheet opens its dialog; the link still works without script.
document.addEventListener('click', (e) => {
  const t = e.target instanceof Element ? e.target : null;
  const open = t && t.closest('[data-sheet]');
  if (open) {
    const d = document.getElementById('sheet-' + open.getAttribute('data-sheet'));
    if (d && d.showModal) { e.preventDefault(); d.showModal(); }
    return;
  }
  if (t && t.closest('[data-close]')) { const d = t.closest('dialog'); if (d) d.close(); return; }
  if (t instanceof HTMLDialogElement && t.classList.contains('sheet')) t.close();
});
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); location.assign('/find'); }
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
