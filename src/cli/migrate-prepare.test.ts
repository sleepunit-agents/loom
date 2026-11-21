import Database from 'better-sqlite3';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { prepareArchiveHome } from './migrate-prepare.js';

it('builds an empty home with the original ownership and settings and refuses to replace it', async()=>{
  const dir=mkdtempSync(join(tmpdir(),'loom-prepare-')), source=join(dir,'source'), home=join(dir,'home');
  const io={stdout(){},stderr(){}}, run=(target=home)=>prepareArchiveHome(['--source',source,'--home',target],io);
  const doc={v:1,agents:['ivy','fern'],default:'fern',owner:'Alex',tz:'America/Chicago',github:'orchard',comms_days:3,
    marks:{ivy:{bg:'#123456',fg:'#ffffff'}},faces:{fern:{shape:'drop',eyes:'dot'}}};
  const save=(value:object)=>writeFileSync(join(source,'household.json'),JSON.stringify(value));
  try{
    mkdirSync(source);
    save({...doc,members:[{person:'alex',role:'member',agents:'*'}]});
    expect(await run()).toBe(1);expect(existsSync(home)).toBe(false);
    save(doc);
    expect(await run(join(source,'nested'))).toBe(1);expect(existsSync(join(source,'nested'))).toBe(false);
    writeFileSync(join(source,'comms.db'),'');
    expect(await run()).toBe(1);expect(existsSync(home)).toBe(false);
    rmSync(join(source,'comms.db'));
    expect(await run()).toBe(0);
    const db=new Database(join(home,'loom.db'),{readonly:true});
    try{
      expect(db.prepare('SELECT id,role,full_owner FROM members').all()).toEqual([{id:'alex',role:'owner',full_owner:1}]);
      expect(db.prepare('SELECT agent FROM member_agents ORDER BY agent').pluck().all()).toEqual(['fern','ivy']);
      expect(db.prepare('SELECT default_agent,timezone,github_owner,comms_days FROM household').get())
        .toEqual({default_agent:'fern',timezone:'America/Chicago',github_owner:'orchard',comms_days:3});
      expect(db.prepare('SELECT mark_bg FROM agents WHERE id=?').pluck().get('ivy')).toBe('#123456');
      expect(db.prepare('SELECT face_shape FROM agents WHERE id=?').pluck().get('fern')).toBe('drop');
      expect(db.prepare('SELECT count(*) FROM jobs').pluck().get()).toBe(0);
    }finally{db.close();}
    save({...doc,github:null});
    const noGithub=join(dir,'no-github');
    expect(await run(noGithub)).toBe(0);
    const blank=new Database(join(noGithub,'loom.db'),{readonly:true});
    try {expect(blank.prepare('SELECT github_owner FROM household').pluck().get()).toBe('');} finally {blank.close();}
    const original=readFileSync(join(home,'comms.key'));
    expect(await run()).toBe(1);expect(readFileSync(join(home,'comms.key'))).toEqual(original);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
