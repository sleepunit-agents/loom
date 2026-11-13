import {expect,it} from 'vitest';
import {z} from 'zod';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createFoundation} from '../../core/app.js';
import {operation,type Viewer} from '../../core/index.js';
import {projectChanges} from './projects-roles.js';
it('selects visible Changes by slug, alias and normalized repositories, preserving original viewer and waiting destinations',()=>{
 const home=mkdtempSync(join(tmpdir(),'project-changes-')),app=createFoundation({home});const viewer:Viewer={kind:'member',id:'partial'};let caller:Viewer|undefined;
 app.operations.register(operation({name:'changes.list',input:z.object({}),output:z.unknown(),may:()=>true,run:ctx=>{caller=ctx.viewer;return [{repo:'github:other/no',project:'on-pond',title:'Alias change',id:'github:other/no#1',updated:'2026-11-13T10:00:00Z',status:'CI red',group:'author',author:{login:'casey'}},{repo:'github:owner/repo',title:'Repo change',id:'github:owner/repo#2',updated:null,status:'Waiting on you',group:'you',author:{login:'pat'}},{repo:'github:hidden/no',title:'Unrelated',id:'github:hidden/no#3',updated:null,status:'Closed',group:'done',author:{login:'hidden'}}];}}));
 try{const s=projectChanges(app.operations).read(viewer,{agent:'art',card:{slug:'pond',name:'Pond',status:'active',where:{},links:{repos:['Owner/Repo']}},names:['pond','on-pond'],notePrefixes:['pond'],since:'2026-11-06T12:00:00Z',now:Date.parse('2026-11-13T12:00:00Z')});expect(caller).toEqual(viewer);expect(s.groups?.flatMap(g=>g.items).map(i=>i.title)).toEqual(['Alias change','Repo change']);expect(s.groups?.find(g=>g.waiting)?.items[0]).toMatchObject({href:'/p/changes-preview/change/github%3Aowner%2Frepo%232',when:'2026-11-13T12:00:00.000Z'});
 }finally{app.close();rmSync(home,{recursive:true,force:true});}
});
