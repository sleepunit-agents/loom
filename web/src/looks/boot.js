// The look before first paint (vite.config.ts emits this as assets/look-<hash>.js, a plain script in index.html's head;
// loom's CSP allows no inline script). This device's copy of the person's look sets <html data-look> and its light or
// dark (data-mode), so a page never flashes another look first: Neon Noir unless the copy says Low Light or Daylight.
// 000h, a look until 2026-11-05, comes across as the nearest one (look.ts lookOf): Daylight if its copy of light or dark
// said light, else Low Light. localStorage is a cache: the choice is the person's, kept by loom (App.tsx applies loom's
// once a page lands). Accessibility's two (src/access.ts) too: <html data-motion> and <html data-contrast>, from this
// device's copy of Reduce motion and Higher contrast (on, off, or else the phone's own setting), so a first paint never
// moves or thins out when the person said not to.
(function () {
  var d = document.documentElement, l, o, m, c;
  try { l = localStorage.getItem('loom-look'); o = localStorage.getItem('loom-mode'); m = localStorage.getItem('loom-motion'); c = localStorage.getItem('loom-contrast'); } catch (e) { /* private window */ }
  var q = function (s) { return !!(window.matchMedia && window.matchMedia(s).matches); };
  d.setAttribute('data-motion', m === 'on' || (m !== 'off' && q('(prefers-reduced-motion: reduce)')) ? 'reduce' : 'full');
  d.setAttribute('data-contrast', c === 'on' || (c !== 'off' && q('(prefers-contrast: more)')) ? 'more' : 'normal');
  if (l === '000h') l = o === 'light' ? 'daylight' : 'lowlight';
  if (l !== 'lowlight' && l !== 'daylight') l = 'neon';
  d.setAttribute('data-look', l);
  d.setAttribute('data-mode', l === 'daylight' ? 'light' : 'dark');
})();
