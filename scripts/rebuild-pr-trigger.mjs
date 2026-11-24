import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {FakeClock} from '../dist/core/clock.js';
import {exampleHome} from '../dist/example-home.js';
import {startSharedHome} from '../dist/shared-startup.js';

export async function pullRequestTriggerEvidence() {
 const dir = await mkdtemp(join(tmpdir(), 'loom-pr-trigger-'));
 const home = join(dir, 'home');
 let app;
 try {
  const example = await exampleHome(home);
  assert.equal(example.fictional, true);
  const clock = new FakeClock(Date.parse(example.createdAt));
  const open = () => startSharedHome({home, clock, host:'127.0.0.1', port:0, stdout(){}});
  app = await open();
  // The reader stands in for GitHub. Sync, the cached change, the post-commit
  // source observation and Inbox delivery all belong to the installed program.
  const changeId = number => 'github:example-house/garden#'+number;
  const change = (number, state) => ({
   id:changeId(number), repo:'github:example-house/garden', number,
   page:'', title:'Check garden pump '+number, body:'', url:'https://example.invalid/pull/'+number,
   state:'open', draft:false, author:{login:'example-fern'}, created:example.createdAt, updated:example.createdAt,
   closed:null, head:{ref:'pump',id:'a'.repeat(40)}, base:{ref:'next'}, mergeable:'yes', conflicts:false,
   checks:{state, failing:state==='failing'?['pump check']:[], running:[], total:1},
   review:{state:'approved',by:[]}, people:[],
  });
  const sync = async (watched, other) => {
   const result = await app.services.changes.sync(async repo => {
    assert.equal(repo, 'example-house/garden');
    return [change(41,watched),change(42,other)];
   },new Date(clock.now()+60_000).toISOString());
   assert.deepEqual(result.map(row=>[row.number,row.checks]),[[41,watched],[42,other]]);
  };
  await sync('passing','passing');
  const words = 'The watched garden pump PR changed.';
  const watch = app.writes.run(()=>app.services.tempo.triggers.set({
   ownerKind:'member', owner:'alex', sourceKind:'pull-request', watches:'change:'+changeId(41),
   lifespan:'until-stopped', targetKind:'inbox', toKind:'person', to:'alex', instructions:words, note:words,
  })).value;
  function deliveries(count) {
   const db = app.services.comms.db.$client;
   assert.equal(db.prepare("SELECT count(*) FROM trigger_log WHERE trigger=? AND event='fired'").pluck().get(watch.id), count);
   const items = db.prepare('SELECT i.id,i.source,i.source_id,i.to_kind,i."to",i.words FROM inbox i JOIN inbox_refs r ON r.item=i.id WHERE r.ref=? ORDER BY i.id').all(watch.id);
   assert.equal(items.length, count);
   assert.equal(db.prepare('SELECT count(*) FROM inbox WHERE words=?').pluck().get(words),count);
   for(const item of items) {
    assert.equal(item.source,'trigger');
    assert.ok(item.source_id.startsWith(watch.id+':'));
    assert.equal(item.to_kind,'person');
    assert.equal(item.to,'alex');
    assert.equal(item.words,words);
   }
   assert.equal(new Set(items.map(item=>item.source_id)).size,count);
   return items.map(item=>item.id);
  }
  deliveries(0);
  await sync('passing','failing');
  deliveries(0);
  await sync('failing','failing');
  const first = deliveries(1);
  await sync('failing','failing');
  assert.deepEqual(deliveries(1),first);
  await sync('passing','failing');
  const both = deliveries(2);
  assert.ok(both.includes(first[0]));
  await app.close();
  app = undefined;
  app = await open();
  assert.deepEqual(deliveries(2),both);
  await sync('passing','failing');
  assert.deepEqual(deliveries(2),both);
  return {ok:true,reason:'Changing checks on the watched pull request fired twice across passing, failing and passing again. Each transition delivered one notice to Alex. An unrelated PR, identical syncs and restart added none.'};
 } finally {
  try { await app?.close(); } finally { await rm(dir,{recursive:true,force:true}); }
 }
}
