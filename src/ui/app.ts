/**
 * loom's own page script, served at /app.js and loaded on every page
 * (script-src 'self'; never inline, and pieces can't add script: their pages
 * are data). The shell's sheets (scope, Places), Cmd/Ctrl-K for Find; the Copy button on a code block (Select where the
 * clipboard needs https), and More on a long text block.
 *
 * Actions post with fetch (X-Loom-Fetch: 1) and answer as a toast above the
 * bottom bar; a danger button asks first in a sheet. A live page (body
 * data-live, seconds) re-fetches itself (X-Loom-Live: 1) and patches in
 * place instead of reloading. Every one of these is the page without script
 * made smoother: the forms still post and redirect, the meta refresh still
 * runs under noscript.
 *
 * Offline: the service worker (src/ui/pwa.ts) hands back the last copy of a
 * page with body data-offline-from; a live check that can't reach loom does
 * the same. Either way the page says how old it is, statuses go hollow, and
 * actions wait for a connection.
 *
 * On a phone a details block opens as a bottom sheet: its body moves into
 * the sheet and back when it closes (moved, not copied, so a form in it
 * stays the one form). On a desktop it expands in place.
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
    if (d && d.showModal) { e.preventDefault(); d.showModal(); const i = d.querySelector('.find-form input'); if (i) { i.focus(); i.select(); } }
    return;
  }
  if (t && t.closest('[data-close]')) { const d = t.closest('dialog'); if (d) { e.preventDefault(); d.close(); } return; }
  if (t instanceof HTMLDialogElement && t.classList.contains('sheet')) t.close();
});
// Find: Cmd/Ctrl-K opens the palette (or the Find page, without the shell). Results follow the typing; arrows walk them; Enter takes the first.
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
    e.preventDefault();
    const d = document.getElementById('sheet-find');
    if (!d || !d.showModal) { location.assign('/find'); return; }
    if (!d.open) d.showModal();
    const i = d.querySelector('.find-form input'); if (i) { i.focus(); i.select(); }
    return;
  }
  const t = e.target instanceof Element ? e.target : null;
  const box = t && t.closest('.find-form, .find-results') ? t.closest('dialog, main') : null;
  if (!box || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return;
  const rows = [...box.querySelectorAll('.find-results a.find-row')];
  if (!rows.length) return;
  e.preventDefault();
  const at = rows.indexOf(t);
  const next = e.key === 'ArrowDown' ? rows[Math.min(at + 1, rows.length - 1)] : at <= 0 ? box.querySelector('.find-form input') : rows[at - 1];
  if (next) next.focus();
});
let finding = null, findTimer = 0;
document.addEventListener('input', (e) => {
  const i = e.target;
  if (!(i instanceof HTMLInputElement) || !i.closest('.find-form')) return;
  clearTimeout(findTimer);
  findTimer = setTimeout(async () => {
    const box = i.closest('dialog, main');
    const q = i.value.trim();
    if (finding) finding.abort();
    finding = new AbortController();
    try {
      const res = await fetch('/find?q=' + encodeURIComponent(q), { signal: finding.signal, credentials: 'same-origin' });
      if (!res.ok) return;
      const next = new DOMParser().parseFromString(await res.text(), 'text/html').querySelector('main .find-results');
      const cur = box && box.querySelector('.find-results');
      if (next && cur) cur.replaceWith(document.importNode(next, true));
      if (box && box.tagName === 'MAIN') history.replaceState(null, '', q ? '/find?q=' + encodeURIComponent(q) : '/find');
    } catch {}
  }, 120);
});
document.addEventListener('submit', (e) => {
  const f = e.target;
  if (!(f instanceof HTMLFormElement) || !f.classList.contains('find-form')) return;
  const first = (f.closest('dialog, main') || document).querySelector('.find-results a.find-row');
  if (first) { e.preventDefault(); location.assign(first.href); }
}, true);

const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };

// A toast: the action's one line, labeled with the piece it came from.
function toast(ok, message, from, keep, undo, csrf) {
  const box = document.querySelector('.toasts');
  if (!box) return;
  const t = el('div', 'flash toast ' + (ok ? 'ok' : 'bad'));
  const g = el('span', 'tg', ok ? '\\u25CF' : '\\u25C6'); g.setAttribute('aria-hidden', 'true');
  t.append(g, el('span', 'tm', message || (ok ? 'Done.' : 'That didn\\'t work.')));
  if (from) t.append(el('span', 'from', from));
  // Undo: the same form the page would render (render.ts flash), posted like any action.
  if (undo && csrf) {
    const f = el('form', 'undo'); f.method = 'post'; f.action = undo.act;
    const hid = (n, v) => { const i = el('input'); i.type = 'hidden'; i.name = n; i.value = v; f.append(i); };
    for (const [k, v] of Object.entries(undo.fields || {})) hid(k, v);
    hid('_csrf', csrf); hid('_action', undo.action); hid('_path', undo.path);
    const b = el('button', 'undo-btn', undo.label || 'Undo'); b.type = 'submit'; f.append(b);
    t.append(f);
  }
  box.append(t);
  linger(t, keep);
}
// A toast goes after a few seconds, unless it holds something to copy; never while it's under the pointer.
function linger(t, keep) {
  const x = el('button', 'toast-close', '\u00D7'); x.type = 'button'; x.setAttribute('aria-label', 'Close');
  x.addEventListener('click', () => t.remove());
  t.append(x);
  if (keep) { t.classList.add('keep'); return; }
  const go = () => { if (t.matches(':hover, :focus-within')) return setTimeout(go, 1500); t.classList.add('out'); setTimeout(() => t.remove(), 300); };
  // One with Undo stays a little longer: there's something to do with it.
  setTimeout(go, t.classList.contains('bad') ? 9000 : t.querySelector('form.undo') ? 8000 : 4000);
}

// A danger button asks first: a sheet that names it and says what happens. Keep it sits nearest the thumb.
function confirmFirst(form, btn) {
  let d = document.getElementById('sheet-confirm');
  if (!d) { d = el('dialog', 'sheet confirm'); d.id = 'sheet-confirm'; document.body.append(d); }
  const go = el('button', 'btn danger', btn.textContent); go.type = 'button';
  const keep = el('button', 'btn', 'Keep it'); keep.type = 'button';
  const grip = el('div', 'sheet-grip'); grip.setAttribute('aria-hidden', 'true');
  const head = el('div', 'sheet-head'); head.append(el('h2', '', btn.textContent + '?'));
  const acts = el('div', 'confirm-actions'); acts.append(go, keep);
  d.replaceChildren(grip, head, el('p', 'sub', btn.dataset.confirm), acts);
  d.setAttribute('aria-label', btn.textContent + '?');
  go.addEventListener('click', () => { d.close(); form.dataset.confirmed = '1'; form.requestSubmit(btn); });
  keep.addEventListener('click', () => d.close());
  d.showModal();
  keep.focus();
}

document.addEventListener('submit', async (e) => {
  const f = e.target;
  if (!(f instanceof HTMLFormElement) || f.method !== 'post') return;
  if (!/^\\/(a\\/[a-z][a-z0-9-]*\\/)?act\\//.test(new URL(f.action, location.href).pathname)) return;
  const btn = e.submitter instanceof HTMLButtonElement ? e.submitter : f.querySelector('button[type=submit]');
  if (btn && btn.dataset.confirm && !f.dataset.confirmed) { e.preventDefault(); confirmFirst(f, btn); return; }
  delete f.dataset.confirmed;
  e.preventDefault();
  const group = f.closest('.ask, .buttons') || f;
  const btns = [...group.querySelectorAll('button')];
  btns.forEach((b) => { b.disabled = true; });
  if (btn) btn.classList.add('busy');
  let r;
  try {
    const res = await fetch(f.action, { method: 'POST', body: new URLSearchParams(new FormData(f)), headers: { 'X-Loom-Fetch': '1' }, credentials: 'same-origin' });
    r = (res.headers.get('content-type') || '').includes('json') ? await res.json() : { ok: false, message: (await res.text()).trim() || 'That didn\\'t work.' };
  } catch { r = { ok: false, message: 'Can\\'t reach loom. Nothing was changed.' }; }
  if (r.go) { location.assign(r.go); return; }
  if (r.ok) {
    // An action from a details sheet closes it: the page under it is about to change.
    const sheet = f.closest('#sheet-details');
    if (sheet && sheet.open) sheet.close();
    const card = f.closest('.ask');
    if (card) card.classList.add('fold');
    await refresh(true);
  } else btns.forEach((b) => { b.disabled = false; });
  if (btn) btn.classList.remove('busy');
  const csrf = f.querySelector('input[name=_csrf]');
  toast(r.ok, r.message, r.from, r.keep, r.undo, csrf && csrf.value);
});

// Live: the page re-fetches itself and patches what changed.
let live = 0, timer = 0, checked = Date.now(), reachable = true;
// How often comes from the page each time: an action can start an install that wants every 3s.
function schedule(every) {
  if (every === live) return;
  live = every; clearInterval(timer); timer = 0;
  if (live) { timer = setInterval(() => refresh(false), live * 1000); status(); }
  else for (const n of document.querySelectorAll('[data-live-status]')) n.textContent = '';
}
// Never under someone's hands: an open sheet, a focused field, or one already changed.
const changed = (i) => i.type === 'checkbox' || i.type === 'radio' ? i.checked !== i.defaultChecked
  : i.tagName === 'SELECT' ? [...i.options].some((o) => o.selected !== o.defaultSelected) : i.value !== i.defaultValue;
const typing = () => document.querySelector('dialog[open]') ||
  [...document.querySelectorAll('main input, main textarea, main select')].some((i) => i.type !== 'hidden' && (i === document.activeElement || changed(i)));
function adopt(n) { return document.importNode(n, true); }
function swap(cur, next) {
  if (!cur || !next) return;
  const open = [...cur.querySelectorAll('details')].map((d) => d.open);
  const n = adopt(next);
  [...n.querySelectorAll('details')].forEach((d, i) => { if (open[i]) d.open = true; });
  cur.replaceWith(n);
  init(n);
}
function patchDash(cur, next) {
  swap(cur.querySelector('.dash-head'), next.querySelector('.dash-head'));
  // New asks always go in at once.
  const ya = cur.querySelector('.your-call'), yb = next.querySelector('.your-call');
  if (ya && yb) swap(ya, yb);
  else if (yb) { const h = cur.querySelector('.dash-head') || cur.firstChild; h.after(adopt(yb)); }
  else if (ya) ya.remove();
  swap(cur.querySelector('.glance-phone'), next.querySelector('.glance-phone'));
  swap(cur.querySelector('.dash-side'), next.querySelector('.dash-side'));
  // New thread rows wait behind a pill, so nothing moves under a reading thumb.
  const ta = cur.querySelector('.thread'), tb = next.querySelector('.thread');
  if (!ta || !tb) return;
  const have = new Set([...ta.querySelectorAll('li[data-key]')].map((li) => li.dataset.key));
  const fresh = [...tb.querySelectorAll('li[data-key]')].filter((li) => !have.has(li.dataset.key)).length;
  let pill = ta.querySelector('.new-pill');
  if (!fresh) { if (pill) pill.remove(); pendingThread = null; return; }
  pendingThread = tb;
  if (!pill) { pill = el('button', 'new-pill'); pill.type = 'button'; ta.querySelector('.label').after(pill); }
  pill.textContent = '\\u2191 ' + fresh + ' new';
}
const phone = () => matchMedia('(max-width: 959px)').matches;
document.addEventListener('click', (e) => {
  const s = e.target instanceof Element ? e.target.closest('main details.details > summary') : null;
  if (!s || !phone()) return;
  const det = s.parentElement, body = det.querySelector(':scope > .details-body');
  const d0 = document.createElement('dialog');
  if (!body || !d0.showModal) return;
  e.preventDefault();
  let d = document.getElementById('sheet-details');
  if (!d) { d = d0; d.id = 'sheet-details'; d.className = 'sheet details-sheet'; document.body.append(d); }
  const title = (s.querySelector('.text') || s).textContent.trim();
  const meta = s.querySelector('.meta');
  const grip = el('div', 'sheet-grip'); grip.setAttribute('aria-hidden', 'true');
  const head = el('div', 'sheet-head'); head.append(el('h2', '', title));
  const x = el('button', 'sheet-close', '\u00D7'); x.type = 'button'; x.setAttribute('data-close', ''); x.setAttribute('aria-label', 'Close'); head.append(x);
  const spot = document.createComment('details-body');
  body.before(spot);
  const holder = el('div', 'sheet-body'); holder.append(body);
  d.replaceChildren(grip, head, ...(meta ? [el('p', 'sub mono', meta.textContent)] : []), holder);
  d.setAttribute('aria-label', title);
  d.addEventListener('close', () => { if (spot.isConnected) spot.replaceWith(body); else spot.remove(); }, { once: true });
  d.showModal();
});
let pendingThread = null;
document.addEventListener('click', (e) => { if (e.target instanceof Element && e.target.closest('a.needs-net')) e.preventDefault(); });
document.addEventListener('click', (e) => {
  const p = e.target instanceof Element ? e.target.closest('.new-pill') : null;
  if (!p || !pendingThread) return;
  swap(p.closest('.thread'), pendingThread);
  pendingThread = null;
});
async function refresh(force) {
  if (!force && (document.hidden || typing())) return;
  let text;
  try {
    const res = await fetch(location.href, { headers: { 'X-Loom-Live': '1' }, credentials: 'same-origin' });
    if (!res.ok || res.redirected) { reachable = res.ok; status(); return; }
    text = await res.text();
  } catch { reachable = false; status(); offline(checked); return; }
  checked = Date.now(); reachable = true;
  onlineAgain();
  const doc = new DOMParser().parseFromString(text, 'text/html');
  const cur = document.querySelector('main'), next = doc.querySelector('main');
  if (!cur || !next) return;
  next.querySelectorAll('.flash').forEach((x) => x.remove());
  if (cur.classList.contains('dash') && !force) patchDash(cur, next);
  else swap(cur, next);
  swap(document.querySelector('.rail'), doc.querySelector('.rail'));
  swap(document.querySelector('nav.bottom'), doc.querySelector('nav.bottom'));
  schedule(Number(doc.body.dataset.live || 0));
  status();
  barTitle();
}
// The page's title slides into the pinned header once it scrolls under it,
// as iOS's large titles do. Only where the header has a way back (Home keeps its wordmark).
let titleObs = null;
function barTitle() {
  if (titleObs) { titleObs.disconnect(); titleObs = null; }
  const top = document.querySelector('.phone-top');
  const slot = top && top.querySelector('.bar-title');
  const h1 = document.querySelector('main h1');
  if (!top || !slot || !h1 || !top.querySelector('.back') || !('IntersectionObserver' in window)) return;
  slot.textContent = h1.textContent;
  titleObs = new IntersectionObserver((es) => {
    for (const e of es) top.classList.toggle('titled', !e.isIntersecting && e.boundingClientRect.top < top.offsetHeight);
  }, { rootMargin: '-' + top.offsetHeight + 'px 0px 0px 0px' });
  titleObs.observe(h1);
}
barTitle();
function status() {
  const s = Math.max(0, Math.round((Date.now() - checked) / 1000));
  const ago = s < 60 ? s + 's' : Math.round(s / 60) + 'm';
  for (const n of document.querySelectorAll('[data-live-status]')) {
    n.textContent = reachable ? 'live \\u00B7 checked ' + ago + ' ago' : 'can\\'t reach loom \\u00B7 last checked ' + ago + ' ago';
    n.classList.toggle('off', !reachable);
  }  for (const n of document.querySelectorAll('[data-stamp]')) {
    n.textContent = reachable ? (s < 5 ? 'updated just now' : 'updated ' + ago + ' ago') : 'offline \\u00B7 updated ' + ago + ' ago';
    n.classList.toggle('off', !reachable);
  }
}
// The stamps count up between refreshes.
setInterval(status, 5000);

// "Offline · from 7:42 AM": what's on screen is old, says how old, and its actions wait.
const clock = (d) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
function howOld(ms) {
  const m = Math.round(ms / 60000);
  return m < 1 ? 'from just now' : m < 60 ? m + (m === 1 ? ' minute' : ' minutes') + ' old' : Math.round(m / 60) + (Math.round(m / 60) === 1 ? ' hour' : ' hours') + ' old';
}
function offline(from) {
  const at = new Date(from);
  if (Number.isNaN(at.getTime())) return;
  document.documentElement.classList.add('offline');
  checked = Math.min(checked, at.getTime()); reachable = false; status();
  let b = document.querySelector('.offline-banner');
  if (!b) {
    b = el('div', 'offline-banner'); b.setAttribute('role', 'status');
    const main = document.querySelector('main');
    if (main) main.prepend(b); else document.body.prepend(b);
  }
  const words = el('span', 'ob-words');
  words.append(el('strong', '', 'Offline \u00B7 from ' + clock(at)), el('span', '', 'What you see is ' + howOld(Date.now() - at.getTime()) + '. Actions wait for a connection.'));
  const g = el('span', 'ob-clock'); g.setAttribute('aria-hidden', 'true');
  b.replaceChildren(g, words);
  for (const btn of document.querySelectorAll('form[action*="/act/"] button, .ask a.go')) {
    if (btn.dataset.label === undefined) btn.dataset.label = btn.textContent;
    btn.disabled = true; btn.classList.add('needs-net'); btn.setAttribute('aria-disabled', 'true');
    btn.textContent = btn.dataset.label + ' \u00B7 needs connection';
  }
}
function onlineAgain() {
  if (!document.documentElement.classList.contains('offline')) return;
  // A kept copy is replaced by the real page; one that only lost the network for a while just lifts.
  if (document.body.dataset.offlineFrom) { location.reload(); return; }
  document.documentElement.classList.remove('offline');
  const b = document.querySelector('.offline-banner'); if (b) b.remove();
  for (const btn of document.querySelectorAll('.needs-net')) { btn.disabled = false; btn.classList.remove('needs-net'); btn.removeAttribute('aria-disabled'); btn.textContent = btn.dataset.label; }
}

// Push for Your call: the Passkeys page's switch for this device (push.ts on the server).
const b64 = (s) => { const p = '='.repeat((4 - (s.length % 4)) % 4); const r = atob((s + p).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(r, (c) => c.charCodeAt(0)); };
async function pushSwitch(b) {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !window.isSecureContext) return;
  const reg = await navigator.serviceWorker.ready;
  const status = document.querySelector('[data-push-status]');
  const say = (t) => { if (status) status.textContent = t; };
  const post = (path, s) => fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ _csrf: b.dataset.csrf, sub: s }) });
  let sub = await reg.pushManager.getSubscription();
  const draw = () => { b.textContent = sub ? 'Turn off on this device' : 'Turn on for this device'; say(sub ? 'On: Your call reaches this device.' : 'Off on this device.'); };
  b.hidden = false; draw();
  b.addEventListener('click', async () => {
    b.disabled = true;
    try {
      if (sub) { const s = sub.toJSON(); await sub.unsubscribe(); await post('/push/unsubscribe', s); sub = null; }
      else {
        if (await Notification.requestPermission() !== 'granted') { say('Notifications are blocked for this site in the browser settings.'); return; }
        const { publicKey } = await (await fetch('/push/key', { credentials: 'same-origin' })).json();
        sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64(publicKey) });
        const r = await post('/push/subscribe', sub.toJSON());
        if (!r.ok) { const why = (await r.json().catch(() => ({}))).error || 'loom said no'; await sub.unsubscribe(); sub = null; say(why); return; }
      }
      draw();
    } catch (e) { say('That failed: ' + (e && e.message ? e.message : e)); } finally { b.disabled = false; }
  });
}

function init(root) {
  if (!(navigator.clipboard && window.isSecureContext)) for (const b of root.querySelectorAll('[data-copy]')) b.textContent = 'Select';
  // A text block clamped at six lines gets More, only when it really overflows.
  for (const t of root.querySelectorAll('[data-clamp]')) {
    const more = t.parentElement && t.parentElement.nextElementSibling;
    if (!more || !more.hasAttribute('data-more')) continue;
    if (t.scrollHeight > t.clientHeight + 2) more.hidden = false;
    more.addEventListener('click', () => { t.classList.add('open'); more.hidden = true; });
  }
}
document.addEventListener('DOMContentLoaded', () => {
  init(document);
  // The app: a service worker where the browser allows one (https, or localhost). The sign-in page drops what it kept.
  if ('serviceWorker' in navigator && window.isSecureContext) {
    if (location.pathname.startsWith('/login')) {
      if (navigator.serviceWorker.controller) navigator.serviceWorker.controller.postMessage('forget');
      if (window.caches) caches.keys().then((ks) => ks.forEach((k) => { if (k.endsWith('-pages')) caches.delete(k); }));
    } else navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
  if (document.body.dataset.offlineFrom) offline(document.body.dataset.offlineFrom);
  for (const b of document.querySelectorAll('[data-push]')) pushSwitch(b).catch(() => {});
  // Opened from a notification: the ask it was about, focused.
  if (location.hash.startsWith('#ask-')) { const a = document.getElementById(location.hash.slice(1)); if (a) { a.focus(); a.scrollIntoView({ block: 'center' }); } }
  window.addEventListener('online', () => { if (document.body.dataset.offlineFrom) location.reload(); else if (live) refresh(true); });
  // The one-time message from a full-page post becomes a toast, and leaves the address.
  for (const f of document.querySelectorAll('main .flash')) {
    const box = document.querySelector('.toasts');
    if (!box) break;
    f.classList.add('toast'); box.append(f);
    linger(f, f.hasAttribute('data-keep'));
  }
  const u = new URL(location.href);
  if (u.searchParams.has('_flash')) { u.searchParams.delete('_flash'); history.replaceState(null, '', u); }
  schedule(Number(document.body.dataset.live || 0));
  setInterval(() => { if (live) status(); }, 1000);
  document.addEventListener('visibilitychange', () => { if (live && !document.hidden && Date.now() - checked > live * 1000) refresh(false); });
});
`;
