// A phone's app, not a web page (Jonathan, 2026-11-05: "We need to disable anything that lets me break the
// illusion"): no pinch or double-tap zoom, and no long-press menu on the app's own chrome, links and images. Most of it
// is CSS (index.css, "A phone's app"); this is what CSS can't do. No React here, so it's tested on its own.
//
// Zoom is the person's to turn back on (Appearance → Allow zoom, off unless they turn it on): blocking it hurts anyone
// who needs to zoom to read. While it's on, nothing here touches zoom.

/** The page's viewport (index.html's is ZOOM_OFF): Allow zoom on drops the cap and lets a person scale the page. */
export const ZOOM_ON = 'width=device-width, initial-scale=1.0, viewport-fit=cover';
export const ZOOM_OFF = `${ZOOM_ON}, maximum-scale=1, user-scalable=no`;

// iOS's Safari ignores user-scalable=no in a tab (since iOS 10), so its own pinch, gesturestart and gesturechange,
// is turned down too. Not passive: a passive listener can't prevent it. A touch screen's only: a Mac's Safari fires the
// same events for a trackpad's pinch, and a desktop keeps its browser's zoom.
const stop = (e: Event) => e.preventDefault();
const touchScreen = (doc: Document) => (doc.defaultView?.navigator.maxTouchPoints ?? 0) > 0;

/** Allow zoom, or don't: the viewport, <html data-zoom> (index.css's touch-action follows it), and iOS's pinch. */
export function allowZoom(on: boolean, doc: Document = document): void {
  const meta = doc.querySelector<HTMLMetaElement>('meta[name="viewport"]');
  if (meta) meta.content = on ? ZOOM_ON : ZOOM_OFF;
  if (on) doc.documentElement.dataset.zoom = 'on';
  else delete doc.documentElement.dataset.zoom;
  for (const t of ['gesturestart', 'gesturechange']) {
    doc.removeEventListener(t, stop);
    if (!on && touchScreen(doc)) doc.addEventListener(t, stop, { passive: false });
  }
}

/** What a long press never opens a menu on: links, images and icons, and the app's chrome (the bars, the dock, Find's
 * pill, buttons and tabs). A long press on a message's or a note's words still selects them. */
/** index.css's chrome list ("Chrome doesn't select"), with links, images and icons: change both. */
export const NO_MENU = 'a[href], img, svg, .loom-top, .loom-dock-bar, .loom-find-pill, .loom-fade, .loom-side, .loom-sheet-bar, .loom-app-tile, ' +
  '.loom-launch-tile, .loom-r-tile, button, [role="button"], [role="tab"], [role="radio"], [role="option"], [role="switch"], [role="checkbox"], ' +
  '[role^="menuitem"], [data-slot="badge"], [data-slot="card-header"], [data-slot="toggle-group"], [data-slot="dock"], label, summary';
const typing = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';

/** Android's Chrome has no -webkit-touch-callout: its long-press menu ("Open in new tab", "Download image") is the
 * contextmenu a touch fires, and that is turned down on what NO_MENU names. A mouse's right click is left alone, and so
 * is a field (its paste). Returns its undoing. */
export function noTouchMenus(doc: Document = document): () => void {
  const menu = (e: Event) => {
    const t = e.target instanceof Element ? e.target : null;
    if (!t || (e as PointerEvent).pointerType === 'mouse' || t.closest(typing) || !t.closest(NO_MENU)) return;
    // A contextmenu without a pointerType (an older Chrome) counts as a touch only on a device without a mouse.
    if (!(e as PointerEvent).pointerType && !doc.defaultView?.matchMedia('(hover: none)').matches) return;
    e.preventDefault();
  };
  doc.addEventListener('contextmenu', menu);
  return () => doc.removeEventListener('contextmenu', menu);
}
