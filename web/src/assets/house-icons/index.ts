// Written by scripts/build-house-icons.py from the files beside it: do not edit (index.test.ts checks it).
// ?no-inline: each icon is a file of its own in the build, named by its content, never text inside the script.
import approvals from './approvals.png?no-inline';
import approvalsSmall from './approvals.small.png?no-inline';
import changes from './changes.png?no-inline';
import changesSmall from './changes.small.png?no-inline';
import comms from './comms.png?no-inline';
import commsSmall from './comms.small.png?no-inline';
import inbox from './inbox.png?no-inline';
import inboxSmall from './inbox.small.png?no-inline';
import tasks from './tasks.png?no-inline';
import tasksSmall from './tasks.small.png?no-inline';
import tempo from './tempo.png?no-inline';
import tempoSmall from './tempo.small.png?no-inline';

/** loom's own icon for an app, by the app's id in its registration: the built files' addresses, the 128 px
 * master (`art`) and the 32 px one a 16 px slot draws (`small`). An app that isn't here has no art yet and keeps
 * its line icon (app-icon.tsx). */
export const HOUSE_ICONS: Readonly<Record<string, { art: string; small: string }>> = {
  approvals: { art: approvals, small: approvalsSmall },
  changes: { art: changes, small: changesSmall },
  comms: { art: comms, small: commsSmall },
  inbox: { art: inbox, small: inboxSmall },
  tasks: { art: tasks, small: tasksSmall },
  tempo: { art: tempo, small: tempoSmall },
};
