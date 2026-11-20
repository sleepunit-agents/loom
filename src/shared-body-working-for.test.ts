/** A body doing a member's private work reaches no further than that member, over the real doors.
 * The agent (art) is in two projects; the member the body works for (alice) is in one of them. */
import { afterEach, expect, it } from 'vitest';
import * as s from './core/data/schema.js';
import { bodyFixture, bodyCredentials } from '../test/fixtures/conversation-body.js';

const clean: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of clean.splice(0).reverse()) await close(); });

async function fixture() {
  const f = await bodyFixture(clean), at = new Date(f.clock.now()).toISOString();
  const tasks = f.root.writes.run(() => {
    // Bob's project: art is in it, alice is not.
    f.db.insert(s.projectMembers).values({ project: 'other', member: 'bob' }).run();
    f.db.insert(s.projectAgents).values({ project: 'other', agent: 'art' }).run();
    const create = (title: string, project: string) => f.root.services.tasks.create({ title, goal: 'g', why: 'w', project, owner: { kind: 'household' } }, { kind: 'member', id: 'bob' });
    for (const project of ['pond', 'other']) {
      f.db.insert(s.approvals).values({ id: 'card-' + project, kind: 'command', target: project, what: 'w', why: 'w', agent: 'mark', project, askedFrom: 'test', actingFor: 'unknown', state: 'pending', minutes: 5, ask: 'a', ifYes: 'y', ifNo: 'n', details: '', askedAt: at }).run();
      f.db.insert(s.changes).values({ id: 'change-' + project, repository: 'house/' + project, number: 1, title: project, body: '', url: '', state: 'open', draft: false, authorLogin: 'mark', project, agent: 'mark', branch: 'b', headCommit: 'a'.repeat(40), baseBranch: 'next', checks: 'running', review: 'required', mergeable: 'unknown', waitingOn: 'ci', openedAt: at, updatedAt: at }).run();
    }
    return { pond: create('Pond task', 'pond').id, other: create('Other task', 'other').id };
  }).value;
  const query = async (token: string) => {
    const response = await f.root.http.request('/graphql', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token }, body: JSON.stringify({ query: '{tasks{title} approvals{id} changes{id} projects{id}}' }) });
    const answer = await response.json() as { data?: Record<string, { title?: string; id?: string }[]>; errors?: unknown[] };
    expect(answer.errors).toBeUndefined();
    return Object.fromEntries(Object.entries(answer.data!).map(([name, rows]) => [name, rows.map(row => row.title ?? row.id).sort()]));
  };
  const comment = (token: string, task: string, id: string) => f.root.http.request('/api/tasks/command', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
    body: JSON.stringify({ input: { action: 'comment', id: task, text: 'Seen' }, id }) });
  return { ...f, tasks, query, comment };
}

it('reads, through a body working for a member, only the projects that member is in', async () => {
  const f = await fixture();
  // The agent's own terminal token reaches both of its projects.
  expect(await f.query(bodyCredentials.agent)).toEqual({ tasks: ['Other task', 'Pond task'], approvals: ['card-other', 'card-pond'], changes: ['change-other', 'change-pond'], projects: ['other', 'pond'] });
  // Its body working alice's thread reaches the one alice is in, as alice herself does.
  const body = await f.query(bodyCredentials.body);
  expect(body).toEqual({ tasks: ['Pond task'], approvals: ['card-pond'], changes: ['change-pond'], projects: ['pond'] });
  expect(await f.query(bodyCredentials.member)).toEqual(body);
});

it('refuses that body a task command in a project its member is not in', async () => {
  const f = await fixture();
  expect((await f.comment(bodyCredentials.body, f.tasks.pond, 'one')).status).toBe(200);
  expect((await f.comment(bodyCredentials.body, f.tasks.other, 'two')).status).toBe(403);
  expect((await f.comment(bodyCredentials.agent, f.tasks.other, 'three')).status).toBe(200);
  expect(f.db.select({ task: s.taskComments.task }).from(s.taskComments).all().map(row => row.task).sort()).toEqual([f.tasks.other, f.tasks.pond].sort());
});

it('gives that body nothing once its member no longer has the agent on their list', async () => {
  const f = await fixture();
  f.root.writes.run(() => f.db.delete(s.memberAgents).run());
  expect((await f.query(bodyCredentials.body)).tasks).toEqual(['Pond task']);
  // The project still reaches, because alice is still in it; what is the agent's own does not.
  const own = f.root.writes.run(() => f.root.services.tasks.create({ title: 'Art own', goal: 'g', why: 'w', owner: { kind: 'agent', id: 'art' } }, { kind: 'agent', id: 'art' }).id).value;
  expect((await f.comment(bodyCredentials.agent, own, 'four')).status).toBe(200);
  expect((await f.comment(bodyCredentials.body, own, 'five')).status).toBe(403);
});
