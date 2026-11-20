// How often an open page is fetched again in place (page.ts usePage). No React here, so it's tested on its own
// (src/ui/refresh.test.ts).
//
// - A piece's page that sets `refresh` (docs/extensions.md, "Pages") asked for exactly that while something is
//   changing (an install, a sign-in being checked): it gets it, live stream or not. The stream only says a piece's
//   manifest moved, never that one of its pages did, so a page waiting on a piece's own state would otherwise wait a
//   minute (Jonathan, 2026-11-02, a box's model login: "should spin and go hey look it worked").
// - Otherwise a page without a form, Home, Today and the Inbox: every 20 seconds, or 60 while the live stream is open
//   (it's only a fallback then). A page with a form, or a sheet: never on its own.

export interface Showing { view: string; page?: { refresh?: number } }

/** Seconds between quiet refetches of what's shown, or 0 for none. */
export function refreshEvery(data: Showing | null | undefined, live: boolean): number {
  if (!data) return 0;
  if (data.view === 'sheet') return 0;
  if (data.view === 'page') {
    const asked = data.page?.refresh;
    if (typeof asked === 'number' && asked > 0) return asked;
    if (JSON.stringify(data.page ?? {}).includes('"type":"form"')) return 0;
  }
  return live ? 60 : 20;
}
