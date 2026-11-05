// The look before first paint (vite.config.ts emits this as assets/look-<hash>.js, a plain script in index.html's head;
// loom's CSP allows no inline script). Neon Noir unless this device's copy of the person's choice says 000h: it sets
// <html data-look>, and for Neon its dark mode and its stylesheet, render-blocking, so a page never flashes 000h first.
// localStorage is a cache: the choice is the person's, kept by loom (App.tsx applies loom's once a page lands).
// Accessibility's two (src/access.ts) too: <html data-motion> and <html data-contrast>, from this device's copy of
// Reduce motion and Higher contrast (on, off, or else the phone's own setting), so a first paint never moves or
// thins out when the person said not to.
(function () {
  var d = document.documentElement, l, m, c;
  try { l = localStorage.getItem('loom-look'); m = localStorage.getItem('loom-motion'); c = localStorage.getItem('loom-contrast'); } catch (e) { /* private window */ }
  var q = function (s) { return !!(window.matchMedia && window.matchMedia(s).matches); };
  d.setAttribute('data-motion', m === 'on' || (m !== 'off' && q('(prefers-reduced-motion: reduce)')) ? 'reduce' : 'full');
  d.setAttribute('data-contrast', c === 'on' || (c !== 'off' && q('(prefers-contrast: more)')) ? 'more' : 'normal');
  if (l !== '000h') {
    l = 'neon';
    d.setAttribute('data-mode', 'dark');
    var k = document.createElement('link');
    k.rel = 'stylesheet'; k.id = 'loom-look-neon'; k.href = '__NEON_CSS__';
    k.setAttribute('blocking', 'render');
    document.head.appendChild(k);
  }
  d.setAttribute('data-look', l);
  d.setAttribute('data-neon-css', '__NEON_CSS__');
})();
