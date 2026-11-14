import { expect, it } from 'vitest';
import { deskRoster } from './roster';
import { namedAgents, orderedAgents } from './home-model';
const owned = { status: 'live' as const, records: [{ id: 'a', name: 'Alpha' }, { id: 'z', name: 'Zulu' }] };
const query = { status: 'live' as const, data: { agents: [{ id: 'a', position: 3 }, { id: 'z', position: 1 }, { id: 'colleague', position: 0 }] } };
it('orders owned cards by generated position across display-name resolution, excluding visible colleagues', () => {
  const records = deskRoster(owned, query).records;
  const named = namedAgents(records, [{ id:'commons:z',slug:'z',name:'Renamed',kind:'agent' }]);
  expect(orderedAgents(named).map(a=>a.id)).toEqual(['z','a']);
  expect(orderedAgents([{id:'z',name:'Alpha',position:1},{id:'a',name:'Zulu',position:1}]).map(a=>a.id)).toEqual(['a','z']);
  expect(owned.records.map(a=>a.id)).toEqual(['a','z']);
});
it.each(['loading','offline','denied'] as const)('clears retained rows when either feed is %s', status => {
  expect(deskRoster({...owned,status},query)).toEqual({status,records:[]});
  expect(deskRoster(owned,{...query,status})).toEqual({status,records:[]});
});
it('drops removals and does not revive revoked ownership on reconnect',()=>{
  expect(deskRoster(owned,{status:'live',data:{agents:[]}}).records).toEqual([]);
  expect(deskRoster({status:'live',records:[]},query).records).toEqual([]);
  expect(deskRoster(owned,{status:'live'})).toEqual({status:'loading',records:[]});
});
