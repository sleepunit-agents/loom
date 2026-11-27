/** What a reference in a conversation can point at, and the key that tells two of them apart. */
type TicketView = { ticket: string; kind: 'ticket' | 'comment'; ref?: string; intent?: 'work' };
export type ScopeView = { kind: 'repository' | 'agent' | 'member'; project: string; ref: string };
export type PullView = { kind: 'pull'; ref: string; ticket?: string };
export const indexNames = {
  browse: 'Browse',
  projects: 'Projects',
  people: 'People',
  agents: 'Agents',
  repositories: 'Repositories',
  tickets: 'Tickets',
  epics: 'Epics',
  pulls: 'Pull requests',
  comments: 'Comments',
} as const;
export type IndexName = keyof typeof indexNames;
export type IndexView = { kind: 'index'; ref: IndexName };
export type ProfileView = { kind: 'profile'; role: 'member' | 'agent' | 'repository' | 'contact'; ref: string };
export type View =
  IndexView | ProfileView | TicketView | PullView | ScopeView | { kind: 'project'; project: string };
export const viewKey = (v: View) =>
  v.kind === 'index'
    ? JSON.stringify([v.kind, v.ref])
    : v.kind === 'profile'
      ? JSON.stringify([v.kind, v.role, v.ref])
      : 'project' in v
        ? JSON.stringify(v.kind === 'project' ? [v.kind, v.project] : [v.kind, v.project, v.ref])
        : JSON.stringify([v.kind, v.kind === 'pull' ? '' : v.ticket, v.ref, 'intent' in v ? v.intent : null]);
export type Related = {
  type: string;
  changedAt: string;
  id: string;
  title: string;
  status: string;
  assignee: string | null;
  goal: string;
};
