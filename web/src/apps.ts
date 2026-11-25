import InboxNotice from './pieces/tempo/notice';
import { machinesApp } from './pieces/machines/registration';
import { subscriptionsApp } from './pieces/subscriptions/registration';
import { usageApp } from './pieces/usage/registration';
import { accountApp } from './pieces/account/registration';
import { settingsApp } from './pieces/settings/registration';
import { setupApp } from './pieces/household/registration';
import { activityApp } from './pieces/activity/registration';
import { agentApp, homeApp, HomeSurface, RailSurface, BarSurface, SignalsSurface } from './pieces/attention/home-registration';
import { projectsApp } from './pieces/projects/registration';
import { knowledgeApp } from './pieces/knowledge/registration';
import { sharingApp } from './pieces/sharing/registration';
import { tempoApp } from './pieces/tempo/registration';
import { commsApp } from './pieces/comms/registration';
import { resolveAppPath } from './shell/router';
import { workApp } from './pieces/work/registration';
import { approvalsApp } from './pieces/approvals/registration';
import { bridgesApp } from './pieces/bridges/registration';
import { inboxApp } from './pieces/attention/registration';
import { peopleApp } from './pieces/people/registration';
import { appearanceApp } from './pieces/appearance/registration';
/** Composition is the one place that chooses the installed first-party apps. */
export const apps = [workApp, approvalsApp, sharingApp, knowledgeApp, inboxApp, bridgesApp, tempoApp, commsApp, homeApp, agentApp, peopleApp, projectsApp, activityApp, usageApp, machinesApp, subscriptionsApp, settingsApp, setupApp, accountApp, appearanceApp];

export const appAt = (path: string) => resolveAppPath(path,apps)?.app;

/** Home's piece may supply these ordinary record-driven surfaces; the shell fetches nothing. */
export const shellSurfaces: import('./shell').ShellSurfaces = { Notice: InboxNotice, Home: HomeSurface, Rail: RailSurface, Bar: BarSurface, Signals: SignalsSurface };
