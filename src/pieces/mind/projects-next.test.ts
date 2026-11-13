import {expect,it} from 'vitest';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createFoundation} from '../../core/app.js';
import {HouseholdDatabase} from '../../core/household/document.js';
import {migrateHouseholdTables} from '../../core/household/schema.js';
import {startLoom} from '../../foundation.js';
import {PeopleStore} from '../../backends/people.js';
import {ProjectsStore} from '../../backends/projects.js';
import type {PersonRecord} from './people-model.js';
it('activates People project destinations in real next composition and resolves their canonical project',async()=>{
 const home=mkdtempSync(join(tmpdir(),'project-next-')),metadata=createFoundation({home});migrateHouseholdTables(metadata.db);metadata.db.transaction(()=>new HouseholdDatabase(metadata.db).replace(home,{v:1,agents:['art'],default:'art',owner:'owner',members:[{person:'owner',role:'owner',agents:'*'}]}))();metadata.close();
 for(const dir of ['commons','agents/art'])mkdirSync(join(home,dir),{recursive:true});
 const people=new PeopleStore({dbPath:join(home,'commons/people.db')}),projects=new ProjectsStore({dbPath:join(home,'agents/art/memories.db')});people.write({slug:'friend',name:'Friend',where:{on_pond:{value:'Maintainer'}}});projects.write({slug:'pond',name:'Pond',links:{aliases:['on-pond']}});
 const app=await startLoom({home,next:true});try{
  const owner={kind:'member' as const,id:'owner'},person=app.operations.call('direct',owner,'mind.personRead',{id:'commons:friend'});expect(person.ok).toBe(true);if(!person.ok)throw Error(person.message);
  const href=(person.value as PersonRecord).projects[0].href;expect(href).toBe('/p/projects-preview/project/art%3Apond');const id=decodeURIComponent(href!.split('/').at(-1)!);expect(app.operations.call('direct',owner,'mind.projectRead',{id})).toMatchObject({value:{id:'art:pond',name:'Pond'}});
 }finally{await app.close();projects.close();people.close();rmSync(home,{recursive:true,force:true});}
});
