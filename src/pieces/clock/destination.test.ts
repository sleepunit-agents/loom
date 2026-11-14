import { expect, it, vi } from 'vitest';
import { clockRoute, type ClockDestination } from './destination.js';
import type { Wake } from './store.js';
const work:Wake={id:'w-test',agent:'art',member:'jonathan',project:'pond',schedule:'art/daily',prompt:'PRIVATE words',note:'PRIVATE note',by:{kind:'agent',id:'art'},due:1,createdAt:0,changedAt:0,state:'firing',failures:0,
 authorship:{origin:'art',conversation:'cv-own',member:'jonathan',project:'pond',principal:{for:'?',people:['pollock']}}};
const witness:ClockDestination={agent:'art',member:'jonathan',project:'pond',conversation:'cv-own',place:'lane:art/daily',current:()=>true};
it('joins only the exact current owning lane destination; principal does not widen routing',()=>{
 const reader=vi.fn(()=>witness);
 expect(clockRoute(work,reader)).toEqual({kind:'join',destination:witness});
 expect(reader).toHaveBeenCalledWith({agent:'art',member:'jonathan',project:'pond',place:'lane:art/daily',service:undefined});
 expect(clockRoute({...work,place:witness.place},reader).kind).toBe('join');
 expect(clockRoute({...work,schedule:undefined,file:'routines/daily.md'},()=>({...witness,place:'lane:daily'})).kind).toBe('join');
});
it.each([
 {authorship:undefined},{authorship:{...work.authorship!,origin:undefined}},
 {authorship:{...work.authorship!,origin:'mark'}},{authorship:{...work.authorship!,conversation:undefined}},
 {authorship:{...work.authorship!,conversation:'cv-elsewhere',principal:{for:'owner',people:[]}}},
 {authorship:{...work.authorship!,member:'pollock'}},{authorship:{...work.authorship!,project:undefined}},
 {place:'alert:runtime-quota'},{place:'lane:other'},
 {schedule:undefined},{authorship:undefined,apiCapacity:{origin:'art',bucket:'cv-own'},legacy:{origin:'art',for_in:'cv-own'}},
])('never gets join authority from missing/mismatching evidence %j',change=>{
 expect(clockRoute({...work,...change},()=>witness)).toEqual({kind:'fresh',place:'wake:w-test'});
});
it.each([
 undefined,{...witness,agent:'mark'},{...witness,member:'pollock'},{...witness,project:undefined},
 {...witness,conversation:'cv-elsewhere'},{...witness,place:'lane:other'},{...witness,current:()=>false},{...witness,service:'slack'},
])('requires a live independent destination witness %j',destination=>{
 expect(clockRoute(work,()=>destination)).toEqual({kind:'fresh',place:'wake:w-test'});
});

it('retains the originating credential service independently of conversation scope',()=>{
 const restricted={...work,authorship:{...work.authorship!,service:'slack'}};
 expect(clockRoute(restricted,()=>witness).kind).toBe('fresh');
 expect(clockRoute(restricted,()=>({...witness,service:'slack'})).kind).toBe('join');
});
