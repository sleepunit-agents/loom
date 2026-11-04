// The look before first paint (vite.config.ts emits this as assets/look-<hash>.js, a plain script in index.html's head;
// loom's CSP allows no inline script). Neon Noir unless this device's copy of the person's choice says 000h: it sets
// <html data-look>, and for Neon its dark mode and its stylesheet, render-blocking, so a page never flashes 000h first.
// localStorage is a cache: the choice is the person's, kept by loom (App.tsx applies loom's once a page lands).
(function () {
  var d = document.documentElement, l;
  try { l = localStorage.getItem('loom-look'); } catch (e) { /* private window */ }
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
