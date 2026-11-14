import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,expect,it} from 'vitest';
import {createFoundation} from '../../foundation.js';
import {migrate} from '../../core/index.js';
import {schema} from './schema/001.js';
import {append,saveThread,type Thread} from './store.js';
import {refsIn,refsOf,indexRefs} from './refs.js';
const close:(()=>void)[]=[];
afterEach(()=>{for(const fn of close.splice(0))fn();});
function fixture(){
 const home=mkdtempSync(join(tmpdir(),'comms-refs-'));const app=createFoundation({home});close.push(()=>{app.close();rmSync(home,{recursive:true,force:true});});migrate(app.db,'comms',schema);
 const t:Thread={id:'th:refs',member:'jonathan',agent:'art',conversation:'cv-refs',title:null,titledBy:null,pinned:false,archived:null,opened:0,last:0,readSeq:0,nextSeq:1,stop:false,firstId:'first',firstHash:'hash',working:false};
 saveThread(app.db,t);
 const add=(id:string,text:string,kind='message')=>app.db.transaction(()=>append(app.db,t,{id,kind,at:t.nextSeq,sender:'jonathan',words:Buffer.from('sealed fixture'),hash:id,record:'{}'},text))();
 return {app,t,add};
}
it('matches the old work grammar without depending on the old store or household settings',()=>{
 expect(refsIn('see t-12, acme/app#3 note:pond/plan. t-12 `t-40`')).toEqual(['t-12','github:acme/app#3','note:pond/plan','t-40']);
 expect(refsIn('at-12 x/acme/app#3 notes:x note:../etc/passwd cv-abc https://example.com bare#1')).toEqual([]);
 expect(refsIn(`note:${'a'.repeat(196)} note:${'b'.repeat(195)}`)).toEqual([`note:${'b'.repeat(195)}`]);
});
it('indexes message/reply once, refreshes the newest mention, and never indexes cards/asks/errors',()=>{
 const {app,t,add}=fixture();add('one','PLANTED see t-1 note:pond/plan');add('two','acme/app#3 t-1','reply');
 add('three','t-999','card');add('four','t-998','ask');add('five','t-997','error');
 expect(refsOf(app.db,t.id)).toEqual([{ref:'t-1',seq:2,pos:1,at:2},{ref:'github:acme/app#3',seq:2,pos:0,at:2},{ref:'note:pond/plan',seq:1,pos:1,at:1}]);
 add('two','t-1000','reply'); // unchanged receipt may not replace its first refs
 expect(refsOf(app.db,t.id).map(r=>r.ref)).not.toContain('t-1000');
 expect(JSON.stringify(app.db.prepare('SELECT * FROM comms_refs').all())).not.toContain('PLANTED');
});
it('keeps newest 200, drops earliest within a message and does not regress on older backfill',()=>{
 const {app,t,add}=fixture();add('one','t-1');add('many',Array.from({length:201},(_,n)=>`t-${n+2}`).join(' '));
 expect(refsOf(app.db,t.id)).toHaveLength(200);expect(refsOf(app.db,t.id)[0].ref).toBe('t-202');
 expect(refsOf(app.db,t.id).map(r=>r.ref)).not.toContain('t-2');
 indexRefs(app.db,t.id,1,1,['t-202']);expect(refsOf(app.db,t.id)[0].seq).toBe(2);
});
it('keeps refs after retention but deletes with its thread and rolls back with the append',()=>{
 const {app,t,add}=fixture();add('one','t-1');
 expect(()=>app.db.transaction(()=>{add('two','t-2');throw new Error('interrupted');})()).toThrow('interrupted');
 expect(refsOf(app.db,t.id).map(r=>r.ref)).toEqual(['t-1']);
 app.db.prepare('UPDATE comms_messages SET words=NULL').run();expect(refsOf(app.db,t.id)).toHaveLength(1);
 app.db.prepare('DELETE FROM comms_threads WHERE id=?').run(t.id);expect(refsOf(app.db,t.id)).toEqual([]);
});

it('keeps the first occurrence within a message, matching the original each-once grammar',()=>{
 const {app,t,add}=fixture();add('many',`${Array.from({length:201},(_,n)=>`t-${n+1}`).join(' ')} t-1`);
 expect(refsOf(app.db,t.id).map(r=>r.ref)).not.toContain('t-1');
 expect(refsOf(app.db,t.id)[0].ref).toBe('t-201');
});
