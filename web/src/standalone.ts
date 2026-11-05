// loom as an app on an iPhone's home screen (iOS's standalone mode). No React here, so it's tested on its own
// (src/ui/standalone.test.ts).
//
// iOS 26 shortens a home-screen app's viewport by the status bar's height while the document is no taller than that
// short viewport (WebKit bug 301108), and the dock's bottom: 0 is that viewport's bottom: Jonathan's dock (2026-11-03)
// sat too high. index.css keeps the document at least the screen's height there, by `display-mode: standalone` and, for
// an iOS that doesn't match it, by this page's class.

/** iOS's home-screen app: only iOS's Safari has `navigator.standalone`, and it's true only there. */
export const iosApp = (nav: Navigator = navigator): boolean => (nav as Navigator & { standalone?: boolean }).standalone === true;

/** Mark the page as iOS's home-screen app (index.css, html.loom-ios-app). Run before the first paint. */
export function markIosApp(doc: Document = document, nav: Navigator = navigator): boolean {
  const on = iosApp(nav);
  doc.documentElement.classList.toggle('loom-ios-app', on);
  return on;
}
