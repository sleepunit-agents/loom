import { describe, it, expect } from 'vitest';
import { attribute, citations, repoId, taskLinks, tasksCited, waitsOn, stateLine, type Change } from './model.js';
import { change } from './fixture.js';
describe('old Changes contract',()=>{
 it('accepts literal GitHub selectors only',()=>{
  expect(repoId('Acme/App')).toBe('github:acme/app');
  for(const raw of ['acme/*','https://github.com/acme/app','forgejo:acme/app','acme/app/extra','acme/app;sh']) expect(()=>repoId(raw)).toThrow();
 });
 it('attributes branches only when the author is the owner',()=>{
  const settings={agents:{art:{logins:['art-bot'],branches:['art/']}},ownerLogins:['owner']};
  const c=change();delete c.agent;
  expect(attribute(c,settings).agent).toBe('art');
  expect(attribute({...c,author:{login:'stranger'}},settings).agent).toBeUndefined();
  expect(attribute({...c,author:{login:'owner'}},settings).agent).toBe('art');
  expect(attribute({...c,author:{login:'OwNeR'}},{...settings,ownerLogins:['OWNER']})).toMatchObject({mine:true,agent:'art'});
  expect(attribute({...c,author:{login:'ART-BOT'}},settings)).toMatchObject({mine:false,agent:'art'});
  expect(attribute({...c,author:{login:'someone'}},settings)).toMatchObject({mine:false});
 });
 it('uses the first matching wait reason',()=>{
  const cases: [Partial<Change>,string][]=[
   [{state:'merged',draft:true},'Merged'],[{state:'closed'},'Closed'],[{draft:true,conflicts:true},'Draft'],
   [{conflicts:true,checks:{state:'failing',failing:['build'],running:[],total:1}},'Conflicts'],
   [{mergeable:'no'},"Can't be merged"],[{checks:{state:'failing',failing:['build'],running:[],total:1}},'CI red'],
   [{review:{state:'changes_requested',by:[]}},'Changes asked for'],[{checks:{state:'running',failing:[],running:['build'],total:1}},'CI running'],
   [{mergeable:'unknown'},'Checking for conflicts'],[{review:{state:'required',by:[]}},'Needs review'],
   [{agent:undefined,mine:true},'Yours'],[{agent:undefined},'Ready'],[{},'Waiting on you']
  ];
  for(const [patch,words] of cases) expect(waitsOn(change(patch)).words).toBe(words);
  expect(waitsOn(change(),{tier:'do'}).group).toBe('agent');
  expect(waitsOn(change(),{tier:'ask',approval:{state:'denied'}}).words).toBe('You said not yet');
  expect(waitsOn(change(),{tier:'do',for:{slug:'loren',name:'Loren',state:'pending'}}).words).toBe('Waiting on you, for Loren');
  expect(stateLine(change({checks:{state:'failing',failing:['build'],running:[],total:1}}),'CI red')).toBe('CI red: build, approved');
 });
 it('links tasks both ways but only trusted task citations vouch for a conversation',()=>{
  const c=change({title:'Fix t-12, not xt-3',body:'cv-111111111111 t-15'});
  expect(tasksCited(c)).toEqual(['t-12','t-15','t-1781']);
  expect(citations('Acme/App#3 github:acme/app#3 https://github.com/Acme/App/pull/3')).toEqual([c.id]);
  const task={id:'t-42',title:'Work',source:'conversation:cv-0123456789ab',comments:[{actor:'outsider',text:'acme/app#3'}]};
  expect(taskLinks(c,[task],['art']).tasks).toEqual([{id:'t-42',title:'Work'}]);
  expect(taskLinks(c,[task],['art']).conversation).toBeUndefined();
  expect(taskLinks(c,[{...task,comments:[{actor:'art',text:'acme/app#3'}]}],['art']).conversation).toBe('cv-0123456789ab');
  expect(taskLinks(c,[{...task,id:'t-12',comments:[]}],['art']).conversation).toBeUndefined();
 });
});
