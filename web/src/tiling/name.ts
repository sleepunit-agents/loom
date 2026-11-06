// An app's name in the tiled desktop's address (docs/specs/desk-tiling.md, "The address"): the last part of its key's
// path (`/p/tasks` → `tasks`, `/a/art` → `art`). One rule for both directions: App.tsx finds an app by its name with it,
// and address.ts writes names with it. Tiny on purpose: App.tsx is the first page.
export const nameOf = (key: string): string => key.split('?')[0].split('/').filter(Boolean).pop() ?? '';
