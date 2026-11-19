// Written by scripts/build-house-icons.py from the files beside it: do not edit (index.test.ts checks it).
// ?no-inline: each icon is a file of its own in the build, named by its content, never text inside the script.
import account from './account.png?no-inline';
import accountSmall from './account.small.png?no-inline';
import activity from './activity.png?no-inline';
import activitySmall from './activity.small.png?no-inline';
import agents from './agents.png?no-inline';
import agentsSmall from './agents.small.png?no-inline';
import appearance from './appearance.png?no-inline';
import appearanceSmall from './appearance.small.png?no-inline';
import approvals from './approvals.png?no-inline';
import approvalsSmall from './approvals.small.png?no-inline';
import bridges from './bridges.png?no-inline';
import bridgesSmall from './bridges.small.png?no-inline';
import changes from './changes.png?no-inline';
import changesSmall from './changes.small.png?no-inline';
import comms from './comms.png?no-inline';
import commsSmall from './comms.small.png?no-inline';
import inbox from './inbox.png?no-inline';
import inboxSmall from './inbox.small.png?no-inline';
import knowledge from './knowledge.png?no-inline';
import knowledgeSmall from './knowledge.small.png?no-inline';
import launcher from './launcher.png?no-inline';
import launcherSmall from './launcher.small.png?no-inline';
import people from './people.png?no-inline';
import peopleSmall from './people.small.png?no-inline';
import projects from './projects.png?no-inline';
import projectsSmall from './projects.small.png?no-inline';
import settings from './settings.png?no-inline';
import settingsSmall from './settings.small.png?no-inline';
import setup from './setup.png?no-inline';
import setupSmall from './setup.small.png?no-inline';
import sharing from './sharing.png?no-inline';
import sharingSmall from './sharing.small.png?no-inline';
import staging from './staging.png?no-inline';
import stagingSmall from './staging.small.png?no-inline';
import tasks from './tasks.png?no-inline';
import tasksSmall from './tasks.small.png?no-inline';
import tempo from './tempo.png?no-inline';
import tempoSmall from './tempo.small.png?no-inline';
import usage from './usage.png?no-inline';
import usageSmall from './usage.small.png?no-inline';

/** loom's own icon for an app, by the app's id in its registration: the built files' addresses, the 128 px
 * master (`art`) and the 32 px one a 16 px slot draws (`small`). An app that isn't here has no art yet and keeps
 * its line icon (app-icon.tsx). */
export const HOUSE_ICONS: Readonly<Record<string, { art: string; small: string }>> = {
  account: { art: account, small: accountSmall },
  activity: { art: activity, small: activitySmall },
  agents: { art: agents, small: agentsSmall },
  appearance: { art: appearance, small: appearanceSmall },
  approvals: { art: approvals, small: approvalsSmall },
  bridges: { art: bridges, small: bridgesSmall },
  changes: { art: changes, small: changesSmall },
  comms: { art: comms, small: commsSmall },
  inbox: { art: inbox, small: inboxSmall },
  knowledge: { art: knowledge, small: knowledgeSmall },
  launcher: { art: launcher, small: launcherSmall },
  people: { art: people, small: peopleSmall },
  projects: { art: projects, small: projectsSmall },
  settings: { art: settings, small: settingsSmall },
  setup: { art: setup, small: setupSmall },
  sharing: { art: sharing, small: sharingSmall },
  staging: { art: staging, small: stagingSmall },
  tasks: { art: tasks, small: tasksSmall },
  tempo: { art: tempo, small: tempoSmall },
  usage: { art: usage, small: usageSmall },
};
