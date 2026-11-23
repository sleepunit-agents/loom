import assert from 'node:assert/strict';
import {join} from 'node:path';
import {mock} from 'node:test';
import Database from 'better-sqlite3';
import {registerProjectHeat} from '../dist/pieces/mind/project-memory-sections.js';
import {withFictionalMemoryHome} from './rebuild-memory-home.mjs';

const day=86_400_000;
const evidence=await withFictionalMemoryHome(async({home,start,open,command,post})=>{
 const remember=async(category,title,content,ttl='permanent')=>{
  const {ids}=await command('memory/remember',{category,title,content,ttl});
  assert.equal(ids.length,1);
  return ids[0];
 };
 mock.timers.enable({apis:['Date'],now:start});
 let db;
 try{
  const episode=await remember('episode','Greenhouse visit','Checked the greenhouse yesterday.');
  const person=await remember('user','Robin’s preference','Robin prefers a morning reminder.');
  const lesson=await remember('feedback','Packing tip','Pack the fictional glass jar upright.');
  const short=await remember('reference','Short notice','The workshop closes early today.','1h');
  db=new Database(join(home,'agents','fern','memories.db'),{readonly:true,fileMustExist:true});
  // Use the same SQLite function the project reader uses to rank the stored rows.
  registerProjectHeat(db);
  const heat=db.prepare('SELECT project_memory_heat(category,created,authored_at,recall_heat,recall_heat_at,sourcing,confidence,observed_at,?) AS heat FROM memories WHERE uuid=?');
  const uuid=id=>id.slice(id.indexOf(':')+1);
  const temperatures=()=>[episode,person].map(id=>heat.get(Date.now(),uuid(id)).heat);
  assert.deepEqual(temperatures(),[1,1]);
  const confidence=db.prepare('SELECT confidence,evidence_count AS observations FROM memories WHERE uuid=?');
  const original=confidence.get(uuid(lesson));
  await command('memory/update',{id:lesson,observation:'confirm'});
  const confirmed=confidence.get(uuid(lesson));
  await command('memory/update',{id:lesson,observation:'contradict'});
  const contradicted=confidence.get(uuid(lesson));
  assert.ok(confirmed.confidence>original.confidence && contradicted.confidence<confirmed.confidence);
  assert.deepEqual([original,confirmed,contradicted].map(row=>row.observations),[1,2,3]);

  const expiry=async()=>(await post('/graphql',{query:'query($id:String!){live:memoryProjectMemory(id:$id){id} archive:memoryArchive(agent:"fern"){entries{id}}}',variables:{id:short}})).data;
  const advanceTo=async time=>{mock.timers.setTime(time);await open(time);};
  await advanceTo(start+3_600_000-1);
  const fresh=await expiry();
  assert.equal(fresh.live.id,short);
  assert.ok(!fresh.archive.entries.some(row=>row.id===short));
  await advanceTo(start+3_600_000);
  const expired=await expiry();
  assert.equal(expired.live,null);
  assert.ok(expired.archive.entries.some(row=>row.id===short));
  await advanceTo(start+day);
  const [episodeDay,personDay]=temperatures();
  assert.equal(episodeDay,0.5);
  assert.ok(personDay>0.99 && personDay<1);
  await advanceTo(start+90*day);
  const [,personDay90]=temperatures();
  assert.equal(personDay90,0.5);
  return {ok:true,episodeDay,personDay,personDay90,expiryAtDeadline:true,confidenceObservations:contradicted.observations,
   reason:'The stored episode lost half its heat in a day. The personal fact took 90 days to reach the same point. The temporary memory moved from live results to the archive at its deadline, and confirming then contradicting a lesson raised then lowered its confidence.'};
 }finally{db?.close();mock.timers.reset();}
});
console.log(JSON.stringify(evidence));
