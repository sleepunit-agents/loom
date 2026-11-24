import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {channel} from 'node:diagnostics_channel';
import {writeFileSync} from 'node:fs';
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {Decrypter} from 'age-encryption';
import {secretHasValue} from '../dist/pieces/secrets/presence.js';
import Database from 'better-sqlite3';
import {startSharedHome} from '../dist/shared-startup.js';

const script=fileURLToPath(import.meta.url);
const name='GARDEN_FIXTURE';
async function start(home){
  const receipt=join(home,'fixture-holder.pid');
  await rm(receipt,{force:true});
  const events=channel('child_process');
  const observe=({process:child})=>child.once('spawn',()=>{
    if(child.spawnargs?.includes(join(home,'secret-holder'))&&child.spawnargs.some(arg=>arg.endsWith('/shared-holder-program.js')))
      writeFileSync(receipt,String(child.pid));
  });
  events.subscribe(observe);
  try{return await startSharedHome({home,host:'127.0.0.1',port:0,stdout(){}});}
  catch(error){await holderExited(home);throw error;}
  finally{events.unsubscribe(observe);}
}
function write(app,id,mode,value='fictional garden seed'){
  const member=app.services.comms.db.$client.prepare("SELECT id FROM members WHERE role='owner'").pluck().get();
  const values=app.services.secrets.values;
  return mode==='remove' ? values.remove({id,member,name}) : values.set({id,member,name,value,description:'Garden fixture',mode});
}
const digest=bytes=>bytes?createHash('sha256').update(bytes).digest('hex'):null;

// Exit the fixture coordinator without running its shutdown hooks. The holder is a separate process.
async function interrupt(home,id,phase,mode){
  const app=await start(home);
  const db=app.services.comms.db.$client;
  if(mode!=='add')await write(app,randomUUID(),'add','first fictional seed');
  const {database}=JSON.parse(await readFile(join(home,'program.json'),'utf8'));
  await writeFile(join(home,'fixture-before.json'),JSON.stringify(digest(records(database,home,id).ciphertext)));
  if(phase==='after-holder'){
    db.function('interrupt_fixture',()=>process.exit(72));
    // The holder has committed. Kill this coordinator before its metadata transaction commits.
    db.exec('CREATE TEMP TRIGGER interrupt_metadata AFTER INSERT ON secret_changes BEGIN SELECT interrupt_fixture(); END');
  }
  const writing=write(app,id,mode);
  if(phase==='before-holder'){
    // Reservation is durable, while the first holder operation is still queued on a microtask.
    assert.equal(db.prepare('SELECT state FROM secret_write_journal WHERE id=?').pluck().get(id),'prepared');
    process.exit(71);
  }
  await writing;
  throw Error('Fixture coordinator unexpectedly finished its write');
}

function records(database,home,id){
  const db=new Database(database,{readonly:true,fileMustExist:true});
  try{
    const holder=new Database(join(home,'secret-holder','holder.db'),{readonly:true,fileMustExist:true});
    try{
      return {
        journal:db.prepare('SELECT state FROM secret_write_journal WHERE id=?').pluck().get(id),
        metadata:db.prepare('SELECT count(*) FROM secrets WHERE name=?').pluck().get(name),
        changes:db.prepare('SELECT id, action FROM secret_changes WHERE secret=? ORDER BY rowid').all(name),
        ciphertext:holder.prepare('SELECT ciphertext FROM holder_values WHERE name=?').pluck().get(name),
      };
    }finally{holder.close();}
  }finally{db.close();}
}

async function holderExited(home){
  let pid;
  try{pid=Number(await readFile(join(home,'fixture-holder.pid'),'utf8'));}catch(error){if(error.code==='ENOENT')return false;throw error;}
  assert.ok(Number.isSafeInteger(pid)&&pid>1);
  await readFile('/proc/self/cmdline');
  // The installed workers run Linux. Confirm the exact fixture process before any cleanup signal.
  async function alive(){
    try{
      const args=(await readFile('/proc/'+pid+'/cmdline','utf8')).split('\0');
      return args.includes(join(home,'secret-holder'))&&args.some(arg=>arg.endsWith('/shared-holder-program.js'));
    }catch(error){if(error.code==='ENOENT'||error.code==='ESRCH')return false;throw error;}
  }
  for(let i=0;i<50;i++){if(!await alive())return true;await delay(50);}
  if(await alive())process.kill(pid,'SIGKILL');
  for(let i=0;i<50&&await alive();i++)await delay(50);
  assert.ok(!await alive(),'Fixture holder survived cleanup');
  return false;
}

async function checkValue(home,app,bytes,expected){
  assert.equal(secretHasValue(app.services.comms.db,name),expected!==undefined);
  if(expected===undefined){assert.equal(bytes,undefined);return;}
  const decrypt=new Decrypter(),identity=await readFile(join(home,'secret-holder','identity'));
  try{decrypt.addIdentity(identity.toString('utf8').trim());}finally{identity.fill(0);}
  const plaintext=await decrypt.decrypt(bytes);
  try{assert.ok(Buffer.from(expected).equals(plaintext),'Recovered value differed from fixture');}
  finally{plaintext.fill(0);}
}

export async function journalRecovery(){
  const dir=await mkdtemp(join(tmpdir(),'loom-journal-recovery-'));
  try{
    for(const [phase,exit,expected] of [['before-holder',71,'undone'],['after-holder',72,'committed']]){
      for(const mode of ['add','replace','remove']){
        const home=join(dir,phase+'-'+mode),id=randomUUID();
        try{
          await assert.rejects(promisify(execFile)(process.execPath,[script,phase,home,id,mode],{timeout:30000}),{code:exit});
        }finally{assert.ok(await holderExited(home),'Separate fixture holder did not exit with its coordinator');}
        const {database}=JSON.parse(await readFile(join(home,'program.json'),'utf8'));
        const interrupted=records(database,home,id);
        const committed=expected==='committed';
        assert.equal(interrupted.journal,'prepared');
        const previous=JSON.parse(await readFile(join(home,'fixture-before.json'),'utf8'));
        const seeded=mode!=='add';
        assert.equal(previous!==null,seeded);
        assert.equal(interrupted.metadata,Number(seeded));
        assert.equal(interrupted.changes.length,Number(seeded));
        if(seeded){
          assert.equal(interrupted.changes[0].action,'add');
          assert.notEqual(interrupted.changes[0].id,id);
        }
        const stored=digest(interrupted.ciphertext);
        if(!committed)assert.equal(stored,previous);
        else if(mode==='remove')assert.equal(stored,null);
        else {assert.ok(stored);assert.notEqual(stored,previous);}
        const expectedValue=committed?(mode==='remove'?undefined:'fictional garden seed'):(seeded?'first fictional seed':undefined);
        for(let restart=0;restart<2;restart++){
          const app=await start(home);
          try{
            const settled=()=>records(database,home,id);
            for(let i=0;i<100 && settled().journal==='prepared';i++)await delay(50);
            const final={journal:expected,metadata:Number(seeded||committed),changes:committed?[...interrupted.changes,{id,action:mode==='remove'?'removed':mode}]:interrupted.changes,ciphertext:interrupted.ciphertext};
            assert.deepEqual(settled(),final);
            await checkValue(home,app,final.ciphertext,expectedValue);
            const retry=write(app,id,mode);
            if(committed)await retry;else await assert.rejects(retry,/undone/);
            assert.deepEqual(settled(),final);
            await checkValue(home,app,final.ciphertext,expectedValue);
          }finally{
            try{await app.close();}finally{assert.ok(await holderExited(home),'Recovered fixture holder did not close');}
          }
        }
      }
    }
    return {ok:true,reason:'Interrupted add, replace and remove before and after a separate holder committed. Two restarts and exact retries preserved the undone or committed outcome, original ciphertext and matching audit count.'};
  }finally{await rm(dir,{recursive:true,force:true});}
}

if(process.argv[1]===script){
  const [, ,phase,home,id,mode]=process.argv;
  assert.ok(['add','replace','remove'].includes(mode));
  assert.ok(['before-holder','after-holder'].includes(phase));
  // A direct invocation may only start a fresh fixture, never open an existing home.
  await mkdir(home,{mode:0o700});
  await interrupt(home,id,phase,mode);
}
