# Desktop app language

> **Archived 2026-11-28 (t-2428).** This describes the desktop page, which was removed: the boards page
> ([docs/specs/boards.md](../specs/boards.md)) is the only page after sign-in, and the sign-in gate is the page at
> every other address. It is kept as the record of what the desktop was; its files are in git before that day.

The desktop started with 22 first-party surfaces. The composition in `web/src/apps.ts` now registers 18 apps and the Home shell surface. Work owns three former launchers. Their old addresses still open the corresponding Work reader, including when restoring a saved desktop.

| Original ID | Current destination | Workflow to exercise |
| --- | --- | --- |
| work | Keep | Open a project, follow activity into its ticket, switch board views, filter by epic and return. |
| tasks | Work backlog, `/p/work/backlog` | Create, search and groom tickets, including unfiled and household-wide work. Read the story, discuss, change priority, manage links, promote to epic and close. |
| changes | Work pull requests, `/p/work/changes` | Browse all visible PRs, including unlinked changes. Read checks and exact-revision reviews, refresh GitHub, follow or request a merge approval. |
| projects | Work agent notes, `/p/work/notes` | Preserve the agent filter, active and quiet cards, sourced fields, people, repositories, recent activity, waiting items and links to authorized notes and memories. |
| inbox | Keep | Switch folders, find a notice, read and answer it, then return to the list. |
| approvals | Keep | Follow a request from Inbox to its exact target, inspect its consequences, answer, and inspect household rules and history. |
| sharing | Keep | Inspect project membership, agent participation and proposed access changes. |
| knowledge | Keep | Browse topics, find a page and read it in context. |
| bridges | Keep | Inspect connections, routes and held outbound messages. |
| tempo | Keep | Open a trigger, read its firing history and follow a resulting job. |
| comms | Keep | Select a thread, read messages, use the composer, and follow a linked question. |
| home-preview | Shell surface | Home, rail, bar and signals present agent presence and attention. Preserve their entry routes and tile behavior. |
| agents | Keep | Open an agent profile, inspect current work and follow the source. |
| people | Keep | Find a person and inspect their identity, contact details and relationships. |
| activity | Keep | Read household events across projects and follow the source record. |
| usage | Keep | Inspect job and conversation usage and follow a job. |
| machines | Keep | Inspect machine status, worker access and running or completed jobs. |
| subscriptions | Keep | Inspect model usage and machine sign-ins. |
| settings | Keep | Inspect household piece settings, secrets and grants. |
| setup | Keep | Manage household members and agents. |
| account | Keep | Manage the current member's passkeys and signed-in browsers. |
| appearance | Keep | Change a personal look and verify it applies across the desktop. |

## Cutover walkthrough

Work owns the project identity. The old Projects reader also accepts an agent-scoped card and a nested memory reference. Resolve those links to the specific authorized contribution or memory. An agent's paused card and a retired household project describe different things. Keep both facts and retain attribution and audience. Project questions continue to resolve through Inbox and permission changes through Sharing.

The three absorbed launchers need source-to-destination coverage for lists, details, saved filters, bookmarks and restored tiles. Exercise links from Inbox, Comms, the rail and Find as well as direct URLs. A ticket opened from the second board page must return to the same epic and page. Keep the remaining registered apps unless a later product decision consolidates their distinct workflows.

## Shared interaction contract

Use Work's route-selected views and contextual filter slot with Inbox's folders, list and reader. Give the active view one visible indicator and an accessible current state. Give a command a verb and a return control a destination. Apps own their routes, filters, subscriptions and authorization. The kit owns layout, keyboard focus and narrow-window behavior.

Exercise a wide window and a narrow tile; operate the views, filter, list and return control by keyboard. Verify an empty list, cold opening, refresh with an item open, reconnect and access withdrawal. Verify on the installed build before closing an adoption ticket.

`ToolbarFrame` in `web/src/kit/toolbar.tsx` accepts an app title and optional mark, a return destination, named views, an action accompanying those views, and controls. The caller identifies the current view from its route. Supply a search field as controls, or render `ToolbarControls` inside a child when that child owns the query. Each mounted frame has its own controls slot. Work supplies its cyan mark and project destinations from `pieces/work/toolbar.tsx`.

For a split-view app, put the shared toolbar and `Split` next to each other in the tile. The toolbar occupies the first row and the split takes the remaining height. Keep folder selection and counts in the folder pane, list paging with the list, and actions that apply to one item with the reader. Inbox supplies its search through the toolbar controls. The split retains Enter to open, Escape to return in a narrow pane, and focus restoration.

Apps built with `AppFrame` inherit the shared toolbar through `AppHeader`. Pass the return destination, commands and filters to the frame. A nested reader can place its controls in the same window using `ToolbarControls`. Sharing keeps its selected project in the window address so returning from Comms restores that project. Approvals carries the History folder in the reader address so closing a past decision returns focus to its original row.
