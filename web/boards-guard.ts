/** The boards page's bundle guard (vite.boards.config.ts runs it over the whole module graph of the build, lazy chunks
 * included; boards-guard.test.ts holds it to what it refuses). The boards page is not the desktop: what it may load
 * is named here, file by file, and anything else fails the build.
 *
 * - Under web/src: the page's own folders, and what the drawn bricks share with the desktop (`shared`).
 * - Under the repository's src/ (the server's code): only the files in `outside`. A file marked `plain` there must
 *   have no import at all, so that the page and the server load that one file and nothing with it; anything it
 *   starts to import fails the build, not only when the import is itself refused.
 * - node_modules, and the few modules vite itself adds. Anything else (a `node:` module, which vite would replace
 *   with an empty stand-in, a virtual module) fails the build. */

// What the drawn bricks share with the desktop, each named whole: words for stored states, selections and the
// calls that send an answer. Each is plain TypeScript with no component and no stylesheet, and so is everything it
// imports. Never `kit/index`, a component or a sheet: a brick that needs one of those needs a pure module instead.
export const shared: ReadonlySet<string> = new Set([
  'kit/words.ts', // displayName
  'kit/time.ts', // the shared date formats
  'pieces/change-view/model.ts', // a pull request's state words (imports kit/words.ts)
  'pieces/inbox-view/model.ts', // an Inbox item's state words, its folders, its rows and outcomes, and the rule for what is answered elsewhere (imports kit/time.ts)
  'pieces/approval-view/model.ts', // an approval's title and kind words
  'pieces/approval-view/answering.ts', // how an approval is read and answered: every safeguard of the answer, as functions and one headless hook (imports react and model.ts)
  'pieces/tempo/change.ts', // a Tempo timings change, checked and said as before and after (imports zod; types from answering.ts)
  'pieces/tempo/model.ts', // Tempo's trigger fields, its words for a kind, a source, a target and a state, and its list's order (no imports)
  'pieces/tempo/query.ts', // Tempo's selections of the triggers, of one trigger, and of its program, journal, runs and history (strings; its import is a type)
  'pieces/tempo/day-model.ts', // the read of a day's recorded firings, their grouping by household day and their outcome words (imports two plain files under src/core)
  'pieces/tempo/runs.ts', // one recent run of a trigger and its words (no imports)
  'pieces/tempo/commands.ts', // the calls to /api/tempo/{set,runNow,stop,start,pause,resume}, each with its receipt (imports data/id and one constant under src/core/tempo/lane-file)
  'pieces/tempo/actions.ts', // the words for a refused Tempo action (the same constant; a type beside it)
  'pieces/measuring/change.ts', // the same for a Measuring settings change (imports src/core/measuring/change)
  'pieces/attention/inbox-query.ts', // the Inbox's selections of a folder and of one item, its inbox.answer call and an approval item's plain words (imports data/ and the two models above)
  'memory/queries.ts', // the People selection of one person
  'memory/query.ts', // its decoder over the data hook
  'pieces/tasks/words.ts', // the words for a ticket's priorities and types
  'pieces/tasks/query.ts', // the Tasks selection of who and which projects a ticket may be given (a string; its imports are types)
  'pieces/work/query.ts', // the Work selection of the tickets under no project (strings and its page size)
  'pieces/activity/model.ts', // Activity's entry types and which link it may follow (no imports)
  'pieces/people/model.ts', // People's grouping of a person with the agents' relationship cards, its search, and which addresses it links (a type beside them)
  'pieces/knowledge/model.ts', // Knowledge's words for a page's freshness, its date and which pages a list holds (types only beside them)
  'pieces/comms/thread-fields.ts', // the fields every reading of a Comms thread row selects
  'pieces/comms-view/model.ts', // Comms' thread row and the order of its list (types and one function)
  'pieces/attention/agent-directory.ts', // the shared directory's agent names, as Comms and Home say them (imports data/ only)
  'pieces/attention/agent-displays.ts', // an agent's mark colours, face shape and eyes (imports data/ only)
  'face-data.json', // the shapes of an agent's face, as data
  'pixel-face.tsx', // an agent's stored pixel sprite, drawn on a canvas by the desktop's own renderer (imports data/, access.ts, contexts/portrait-player.ts and one plain file under src/; no kit, no sheet)
  'shell/shortcuts.ts', // the declared shortcuts and the engine that reads their keys (imports react only)
  'pieces/attention/home-model.ts', // an agent's state word and line, the roster's order (types and functions)
  'pieces/attention/roster.ts', // Home's roster: the member's own agents (imports data/ only)
  'pieces/attention/agent-status.ts', // each agent's reported state and work (imports data/ only)
  'pieces/attention/agent-profiles.ts', // each agent's description (imports data/ only)
  'pieces/attention/home-comms-data.ts', // Home's summary of the member's threads per agent (imports data/ only)
  'pieces/attention/doing-model.ts', // what an agent is doing now: the read and its sentences (imports kit/time.ts)
  'pieces/attention/waiting-counts.ts', // how many questions wait on the member, per agent (imports data/ only)
  'pieces/account/notifications.ts', // notifications on this browser: its state, turning a device on and off by Account's own operations (imports data/, encoding.ts and two plain files under src/)
  'pieces/account/encoding.ts', // base64url to bytes, for the push key (no imports)
  'pieces/account/query.ts', // Account's one selection of the member's own passkeys, browsers and devices (a string and a type)
  'pieces/account/passkey.ts', // adding a passkey through the sign-in door, as Account does (imports encoding.ts)
  'signin/device-link.ts', // the one-time sign-in link for another device: its request and words (no imports)
  'pieces/attention/desk-time.ts', // the household's time zone selection, which data/zone.ts reads (a string and a type)
  'pieces/appearance/choices.ts', // Appearance's choices as words: follow/on/off, the grounds, the switches (no imports)
  'look.ts', // the looks' names and how a saved look is read (imports react's createContext; its other imports are types)
  'shell/member-preferences.ts', // the shell's selection of the member's own preferences and its rule for whose row counts (imports data/ and attention/home-comms-data.ts)
  'pieces/settings/data.ts', // Settings' one selection of secrets, grants, requests, rules and uses, and how it is read (its imports are types)
  'pieces/settings/commands.ts', // Settings' calls: a secrets command, and the one way a secret's value leaves the browser (imports data/id.ts)
  'pieces/settings/words.ts', // Settings' words for answers, uses and outcomes (no imports)
  'signin/session-change.ts', // signing a browser out and then checking this one is still signed in (imports data/)
  'pieces/runtime/machine-hosting-model.ts', // what a machine hosts, as fields and words (no imports)
  'pieces/runtime/machines-query.ts', // the Machines app's two reads and the shapes its operations answer (strings and types)
  'pieces/runtime/machine-readings.ts', // a machine's readings and open conditions as the desktop says them (imports kit/time.ts and one plain file under src/)
  'pieces/household/alert-lines-model.ts', // the machine alert lines: labels, bounds and the check of a typed change (no imports)
  'pieces/runtime/model-query.ts', // the Subscriptions app's selections, its account and service lines, weekly usage and the words of adding one and asking for a sign-in (imports data/ only)
  'pieces/usage/model.ts', // Job usage's two selections, its order, the names of a job's measurements and its range of local days (no imports)
  'pieces/bridges/command.ts', // the Bridges door: one command, true only when loom saved it (imports data/id.ts)
  'pieces/bridges/data.ts', // the Bridges app's one selection, its snapshot, which replies wait and their words (its imports are types)
  'pieces/household/model.ts', // Household setup's two selections, the shapes loom answers, who owns an agent and the words of a change (no imports)
  'pieces/sharing/model.ts', // the Sharing app's one selection and the shape loom answers (no imports)
  'pieces/comms/drafts.ts', // the Comms composer's draft for a member and a conversation, in this browser's storage only, and its retry id (imports react and comms-id.ts)
  'comms-id.ts', // a Comms message's id, which a draft carries as its retry id (no imports)
  'pieces/comms/conversation-query.ts', // the conversation activity's selections, the bridge receipt's among them, and their shapes (no imports)
]);
const own = /^(access\.ts$|boards\/|pair\/|contexts\/(?:portrait\.tsx|portrait-player\.ts|manifest\.json|sheet\.png)$|data\/|signin\/use-session\.ts$|lib\/utils\.ts$|pieces\/comms\/use-deadline\.ts$)/;

/** The server's files the page loads, each with why. `plain`: it must import nothing. */
export const outside: ReadonlyMap<string, { plain?: true; why: string }> = new Map([
  ['src/core/boards/value-shape.ts', { plain: true, why: 'whether a typed name is a pasted secret value: the one test the page and boards.act use' }],
  ['src/core/boards/bricks/kit.ts', { why: 'the bricks\' reference shapes (zod; value-shape.ts)' }],
  ['src/core/boards/bricks/tickets.ts', { why: 'the tickets brick\'s choices (zod; kit.ts)' }],
  ['src/core/boards/bricks/catchup.ts', { why: 'the catchup brick\'s choices (zod; kit.ts)' }],
  ['src/core/boards/refs.ts', { why: 'how a record reference is read' }],
  ['src/apps/shell-command-record.ts', { why: 'a shell command\'s record shape' }],
  ['src/core/clock.ts', { why: 'the household clock' }],
  ['src/core/day.ts', { why: 'a household day' }],
  ['src/core/conversations/trace-keep-days.ts', { why: 'how long a session\'s steps are kept' }],
  ['src/core/data/live-pace.ts', { why: 'how often a live read is asked again' }],
  ['src/core/internal.ts', { why: 'what is internal (policy.ts)' }],
  ['src/core/measuring/change.ts', { why: 'a Measuring settings change (zod; index.ts)' }],
  ['src/core/measuring/index.ts', { why: 'Measuring\'s settings (day.ts, clock.ts)' }],
  ['src/core/sha256-hex.ts', { why: 'a hex digest' }],
  ['src/core/signin/browser-device.ts', { why: 'a browser\'s device name' }],
  ['src/core/tempo/calendar.ts', { why: 'Tempo\'s calendar (day.ts)' }],
  ['src/core/tempo/lane-file.ts', { why: 'one constant of a Tempo lane file' }],
  ['src/desk-sprite-layout.ts', { why: 'an agent sprite\'s layout' }],
  ['src/pieces/bridges/keys.ts', { why: 'the Bridges keys' }],
  ['src/policy.ts', { why: 'policy words (internal.ts)' }],
  ['src/proposal-words.ts', { why: 'a proposal\'s words' }],
  ['src/runtime/machine-reading-time.ts', { why: 'a machine reading\'s time' }],
  ['src/slug.ts', { why: 'a household id\'s shape (zod)' }],
  ['src/task-route.ts', { why: 'a ticket\'s address (slug.ts)' }],
  ['src/ui/notification-target.ts', { why: 'where a notification leads' }],
]);
/** Modules vite and rolldown add of their own. */
const tooling = new Set(['\0vite/modulepreload-polyfill.js', '\0vite/preload-helper.js', '\0rolldown/runtime.js']);

export type Seen = { id: string; imports: readonly string[] };
/** Each module the build loaded, by id, against `root` (the repository's root); the reasons the build must fail. */
export function boardsGuard(modules: Iterable<Seen>, root: string): string[] {
  const base = root.replace(/\/+$/, '') + '/', problems: string[] = [];
  for (const { id: raw, imports } of modules) {
    const id = raw.split('?')[0]!;
    if (tooling.has(id) || id.includes('/node_modules/')) continue;
    if (!id.startsWith(base)) { problems.push('Not a file of this repository in boards page: ' + raw); continue; }
    const path = id.slice(base.length);
    if (path === 'web/board.html') continue;
    if (path.startsWith('web/src/')) {
      const file = path.slice('web/src/'.length);
      if (!own.test(file) && !shared.has(file)) problems.push('Desktop dependency in boards page: ' + file);
    } else if (path.startsWith('src/')) {
      const entry = outside.get(path);
      if (!entry) problems.push('Server file in boards page: ' + path);
      else if (entry.plain && imports.length) problems.push(`A plain file imports in boards page: ${path} imports ${imports.map((i) => i.startsWith(base) ? i.slice(base.length) : i).join(', ')}`);
    } else problems.push('Not a page file in boards page: ' + path);
  }
  return problems;
}
