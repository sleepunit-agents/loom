import { dirname } from 'node:path';
import { HouseholdDatabase } from './core/household/document.js';
import { SharingDatabase } from './core/household/sharing.js';
import { installSharing } from './pieces/sharing/index.js';
import { mkdirSync, readdirSync } from 'node:fs';
import { migrate, type Sharing } from './core/index.js';
import { createFoundation, type Foundation } from './core/app.js';
import { installChanges } from './pieces/changes/index.js';
import { installTasks } from './pieces/tasks/index.js';
import { installApprovals } from './pieces/approvals/index.js';
import { installExample } from './pieces/example/index.js';
export const fixtureSharing = (): Sharing => ({
  members: { jonathan: { owner: true, agents: ['art', 'mark'] }, pollock: { owner: false, agents: ['pond-bot'] } },
  projects: { pond: { members: ['pollock'], agents: ['pond-bot', 'art'] }, other: { members: [], agents: ['art'] } },
  services: { keyholder: { types: ['secret'], operations: ['secrets.unlock'] } },
});
export function installFixture(app: Foundation, sharing: () => Sharing = fixtureSharing) {
  migrate(app.db, 'fixture', [{ number: 1, sql: 'CREATE TABLE fixture_sharing (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL)' }]);
  app.db.prepare('INSERT OR IGNORE INTO fixture_sharing VALUES (1, ?)').run(JSON.stringify(sharing()));
  const home = dirname(app.db.name);
  if (!app.operations.has('household.createProject')) installSharing(app, home);
  const household = new HouseholdDatabase(app.db);
  if (!household.document()) app.db.transaction(() => {
    const held = sharing();
    const agents = [...new Set([...Object.values(held.members).flatMap(m => m.agents), ...Object.values(held.projects).flatMap(p => p.agents)])];
    household.replace(home, { v: 1, agents, members: Object.entries(held.members).map(([person, member]) => ({ person, role: member.owner ? 'owner' : 'member', agents: member.owner ? '*' : member.agents })) });
    const store = new SharingDatabase(app.db, home);
    for (const [slug, project] of Object.entries(held.projects)) store.create({ slug, name: slug === 'pond' ? 'Pond' : slug, repositories: [], ...project });
  })();
  // Explicit mutable sharing overrides remain useful for policy tests; default fixtures use the real database.
  if (sharing === fixtureSharing) {
    const store = new SharingDatabase(app.db, home);
    sharing = () => ({ ...store.sharing(), services: fixtureSharing().services });
  }
  if (!app.operations.has('tasks.list')) installTasks(app.db, app.operations, app.live, sharing);
  if (!app.operations.has('changes.list')) installChanges(app.db, app.operations, app.live, sharing);
  if (!app.operations.has('approvals.list')) installApprovals(app.db, app.operations, app.live, sharing);
  installExample(app.db, app.operations, app.live, sharing);
}
/** A fresh, disposable staging/test home; never overwrite an existing home. */
export function fixture(home: string) {
  mkdirSync(home, { recursive: true });
  if (readdirSync(home).length) throw new Error('fixture requires an empty directory');
  const app = createFoundation({ home });
  try {
    installFixture(app);
    const examples = [
      { id: 'pond-task', title: 'Pond task by Art', project: 'pond', agent: 'art' },
      { id: 'other-task', title: 'Other project by Pond-bot', project: 'other', agent: 'pond-bot' },
      { id: 'bot-task', title: 'Pond-bot personal', agent: 'pond-bot' },
      { id: 'household-task', title: 'Household' },
      { id: 'jonathan-thread', title: 'Private', project: 'pond', agent: 'art', member: 'jonathan' },
      { id: 'pollock-thread', title: 'Private', project: 'pond', agent: 'pond-bot', member: 'pollock' },
    ];
    for (const input of examples) {
      const result = app.operations.call('direct', { kind: 'member', id: input.member ?? 'jonathan' }, 'example.put', input, `fixture:${input.id}`);
      if (!result.ok) throw new Error(`fixture: ${result.message}`);
    }
    for (const input of [
      { title: 'Pond work', project: 'pond', agent: 'art' },
      { title: 'Other project work', project: 'other', agent: 'pond-bot' },
      { title: 'Pond-bot own work', agent: 'pond-bot' },
      { title: 'Unfiled household work' },
    ]) {
      const result = app.operations.call('direct', { kind: 'member', id: 'jonathan' }, 'tasks.create', { ...input, actor: 'fixture', at: '2026-11-12T00:00:00.000Z' }, `fixture:task:${input.title}`);
      if (!result.ok || !(result.value as { result: { ok: boolean } }).result.ok) throw new Error('fixture task creation failed');
    }
  } finally { app.close(); }
}
