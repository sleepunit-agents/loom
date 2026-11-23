import {expect,it} from 'vitest';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PeopleStore} from '../src/backends/people.js';

it('imports only exclusive registry and card matches and reconciles removed entries',()=>{
  const home=mkdtempSync(join(tmpdir(),'person-alias-'));
  const path=join(home,'people.db'), registry=join(home,'registry.json'), workspace='TWORK';
  const db=new PeopleStore({dbPath:path});
  try{
    const one='U00000001',two='U00000002',three='U00000003';
    db.write({slug:'sam',name:'Sam',where:{slack:{value:[one,two,three]}}});
    db.write({slug:'alex',name:'Alex',where:{slack:{value:'Shared contact '+three}}});
    const people={sam:{slack:{[workspace]:[one,two,three]}},alex:{slack:{[workspace]:[two]}}};
    writeFileSync(registry,JSON.stringify({people}));
    const run=(...flags:string[])=>JSON.parse(execFileSync(process.execPath,
      ['--import','tsx',join(import.meta.dirname,'import-person-sighting-aliases.ts'),path,registry,workspace,...flags],{encoding:'utf8'}));
    expect(run()).toEqual({matched:1,add:1,remove:0,applied:false});
    expect(db.database.prepare('SELECT account FROM person_sighting_aliases').all()).toEqual([]);
    const approved=join(home,'approved.json');
    writeFileSync(approved,JSON.stringify([[workspace,one,'alex']]));
    expect(()=>run('--apply',approved)).toThrow();
    expect(db.database.prepare('SELECT account FROM person_sighting_aliases').all()).toEqual([]);
    writeFileSync(approved,JSON.stringify([[workspace,one,'sam']]));
    expect(run('--apply',approved)).toMatchObject({matched:1,add:1,applied:true});
    expect(run('--apply')).toMatchObject({add:0,remove:0});
    expect(db.database.prepare('SELECT account,slug FROM person_sighting_aliases').all()).toEqual([{account:one,slug:'sam'}]);
    const fourth='U00000004';
    db.write({slug:'sam',where:{slack:{value:[one,two,three,fourth]}}});
    people.sam.slack[workspace].push(fourth);
    writeFileSync(registry,JSON.stringify({people}));
    writeFileSync(approved,JSON.stringify([[workspace,fourth,'sam']]));
    expect(run('--apply',approved)).toMatchObject({matched:2,add:1,remove:0});
    writeFileSync(registry,JSON.stringify({people:{}}));
    expect(run('--apply')).toMatchObject({matched:0,add:0,remove:2});
  }finally{db.close();rmSync(home,{recursive:true,force:true});}
});
