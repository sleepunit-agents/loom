/** What a household owner gets of another member's private thread with an agent, over the real doors:
 * nothing to read, and the one thing docs/specs/comms.md leaves them, ending its stuck job. */
import { afterEach, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import * as s from './core/data/schema.js';
import { bodyFixture, bodyCredentials, credentialHash } from '../test/fixtures/conversation-body.js';

const clean: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of clean.splice(0).reverse()) await close(); });
const ownerToken = 'o'.repeat(64);

async function fixture() {
  const f = await bodyFixture(clean), at = new Date(f.clock.now()).toISOString();
  f.root.writes.run(() => {
    // A full owner: the owner role, and every agent on their own list.
    f.db.insert(s.members).values({ id: 'olive', role: 'owner', fullOwner: true, joinedAt: at }).run();
    f.db.insert(s.memberAgents).values({ member: 'olive', agent: 'art' }).run();
    f.db.insert(s.tokens).values({ fingerprint: credentialHash(ownerToken), label: 'Olive', kind: 'owner', member: 'olive', createdAt: at }).run();
    // Alice's thread has a job with words in it, a turn and a digest.
    f.db.update(s.jobs).set({ title: 'PRIVATE TITLE', brief: 'PRIVATE BRIEF' }).where(eq(s.jobs.id, 'job')).run();
    f.root.services.conversations.turn({ conversation: f.thread.conversation, kind: 'reply', fromKind: 'agent', fromId: 'art' });
    f.root.services.conversations.digest({ conversation: f.thread.conversation, run: 'run', summary: 'PRIVATE DIGEST', items: [{ kind: 'decision', text: 'PRIVATE DECISION' }] });
  });
  const query = async (source: string, token: string) => {
    const response = await f.root.http.request('/graphql', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token }, body: JSON.stringify({ query: source }) });
    return await response.json() as { data?: Record<string, unknown>; errors?: unknown[] };
  };
  return { ...f, query };
}
const everything = `{conversations{id label} conversationPeople{who} turns{seq} digests{summary} digestItems{text} findings{text}
  commsThreads{id} commsThread(id:"THREAD"){title} commsMessages(thread:"THREAD"){words} recentConversations(agent:"art"){id label}
  currentJobs(agent:"art"){id title} jobHistory(agent:"art"){id title} inboxItems{id}}`;

it('shows a household owner nothing of another member\'s private thread: no row, word, digest, job or mail', async () => {
  const f = await fixture();
  expect((await f.send('PRIVATE WORDS', 'one')).status).toBe(200);
  const source = everything.replaceAll('THREAD', f.thread.id);
  // Its member reads all of it.
  const mine = await f.query(source, bodyCredentials.member);
  expect(mine.errors).toBeUndefined();
  expect(JSON.stringify(mine.data)).toContain('PRIVATE TITLE'); expect(JSON.stringify(mine.data)).toContain('PRIVATE DIGEST'); expect(JSON.stringify(mine.data)).toContain('PRIVATE WORDS');
  // A full owner, who has both the role and the agent, reads none of it.
  const theirs = await f.query(source, ownerToken);
  expect(theirs.errors).toBeUndefined();
  expect(theirs.data).toEqual({ conversations: [], conversationPeople: [], turns: [], digests: [], digestItems: [], findings: [],
    commsThreads: [], commsThread: null, commsMessages: [], recentConversations: [], currentJobs: [], jobHistory: [], inboxItems: [] });
});

it('still lets a household owner end that thread\'s job, without being shown it', async () => {
  const f = await fixture();
  const stop = await f.root.http.request('/api/runtime/jobStop', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + ownerToken }, body: JSON.stringify({ input: { job: 'job', reason: 'write-off' }, id: 'stop' }) });
  expect(stop.status).toBe(200);
  // The answer says that it stopped and nothing of the job.
  const answer = await stop.text();
  expect(JSON.parse(answer)).toMatchObject({ ok: true, value: { stopped: true } });
  expect(answer).not.toContain('PRIVATE');
  expect(f.db.select().from(s.jobs).get()).toMatchObject({ state: 'stopped', endedBy: 'olive', endedReason: 'write-off' });
  expect((await f.query('{jobHistory(agent:"art"){id title}}', ownerToken)).data).toEqual({ jobHistory: [] });
});

it('shows only the private job’s machine facts and its own digest to a household owner of that box', async () => {
  const f = await fixture();
  const selection = '{privateMachineJobs(agent:"art"){id agent state box queuedAt claimedAt endedAt summary}}';
  const none = {data:{privateMachineJobs:[]}};
  expect(await f.query(selection, ownerToken)).toEqual(none);
  f.root.writes.run(() => f.db.update(s.boxes).set({owner:'olive'}).where(eq(s.boxes.id,'box')).run());
  const row = {id:'job',agent:'art',state:'running',box:'box',queuedAt:new Date(f.clock.now()).toISOString(),claimedAt:null,endedAt:null,summary:null};
  expect(await f.query(selection, ownerToken)).toEqual({data:{privateMachineJobs:[row]}});
  f.root.writes.run(() => f.root.services.conversations.digest({conversation:f.thread.conversation,run:'job',summary:'Garden inspection finished.',items:[{kind:'decision',text:'Private decision details'}]}));
  expect(await f.query(selection, ownerToken)).toEqual({data:{privateMachineJobs:[{...row,summary:'Garden inspection finished.'}]}});
  for (const credential of [bodyCredentials.agent, bodyCredentials.member]) expect(await f.query(selection, credential)).toEqual(none);
  expect(await f.query('{jobHistory(agent:"art"){title brief logTail} digests{summary} digestItems{text}}',ownerToken)).toEqual({data:{jobHistory:[],digests:[],digestItems:[]}});
  const forbidden=await f.query('{privateMachineJobs(agent:"art"){title brief logTail conversation}}',ownerToken);
  expect(forbidden.data).toBeUndefined();expect(forbidden.errors).toHaveLength(4);
  f.root.writes.run(() => f.db.update(s.members).set({role:'member',fullOwner:false}).where(eq(s.members.id,'olive')).run());
  expect(await f.query(selection, ownerToken)).toEqual(none);
});

it('pages private jobs before choosing the newest digest for each matching conversation and run', async () => {
  const f = await fixture(), at = new Date(f.clock.now()).toISOString();
  const page = Array.from({length:32}, (_, i) => 'run-' + String(i).padStart(2,'0'));
  f.root.writes.run(() => {
    f.db.update(s.boxes).set({owner:'olive'}).where(eq(s.boxes.id,'box')).run();
    const template = f.db.select().from(s.jobs).where(eq(s.jobs.id,'job')).get()!;
    const other = f.root.services.conversations.open({agent:'art',venue:'wake',place:'different',label:'Other conversation'});
    for (const id of page) {
      f.db.insert(s.jobs).values({...template,id,state:'done'}).run();
      const same = {conversation:f.thread.conversation,run:id,at};
      f.db.insert(s.digests).values([
        {...same,id:id+'-old',revision:1,summary:'old'},
        {...same,id:id+'-new',revision:2,summary:id},
        {...same,id:id+'-elsewhere',revision:3,summary:'from a different conversation',conversation:other.id},
      ]).run();
    }
  });
  expect(await f.query('{privateMachineJobs(agent:"art"){id summary}}',ownerToken)).toEqual({
    data:{privateMachineJobs:page.reverse().slice(0,30).map(id=>({id,summary:id}))},
  });
});
