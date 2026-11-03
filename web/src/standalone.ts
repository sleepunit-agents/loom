// loom as an app on an iPhone's home screen (iOS's standalone mode). No React here, so it's tested on its own
// (src/ui/standalone.test.ts).
//
// There the page doesn't scroll: the app does, inside #root (index.css, html.loom-ios-app). In iOS's standalone mode a
// `position: fixed` bar moves with the page when the document itself is what scrolls: Jonathan's dock (2026-11-03) sat
// too high when the app opened and dropped to the bottom once the page scrolled. With the document still, the dock is
// fixed to the screen's bottom from the first paint. Safari's own tabs, Android and desktops scroll the page, as before.

/** iOS's home-screen app: only iOS's Safari has `navigator.standalone`, and it's true only there. */
export const iosApp = (nav: Navigator = navigator): boolean => (nav as Navigator & { standalone?: boolean }).standalone === true;

/** Mark the page so its CSS scrolls #root instead of the document. Run before the first paint. */
export function markIosApp(doc: Document = document, nav: Navigator = navigator): boolean {
  const on = iosApp(nav);
  doc.documentElement.classList.toggle('loom-ios-app', on);
  return on;
}

/** Back to the top of the page, whichever scrolls: #root in the iOS app, else the window. */
export function toTop(doc: Document = document): void {
  const own = doc.documentElement.classList.contains('loom-ios-app') ? doc.getElementById('root') : null;
  (own ?? doc.defaultView)?.scrollTo({ top: 0 });
}
