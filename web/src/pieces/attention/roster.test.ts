import { expect, it } from 'vitest';
import { deskRoster } from './roster';
import { namedAgents, orderedAgents } from './home-model';
const query = { status: 'live' as const, data: { homeComms: {member:'sam',agents:['a','z']}, agents: [{ id: 'a', position: 3 }, { id: 'z', position: 1 }, { id: 'colleague', position: 0 }] } };
it('orders current owned cards by generated position, excluding visible colleagues', () => {
  const records = deskRoster(query).records;
  const named = namedAgents(records, [{ id:'commons:z',slug:'z',name:'Renamed',kind:'agent' }]);
  expect(orderedAgents(named).map(a=>a.id)).toEqual(['z','a']);
  expect(named.find(a=>a.id==='z')?.name).toBe('Renamed');
  expect(orderedAgents([{id:'z',name:'Alpha',position:1},{id:'a',name:'Zulu',position:1}]).map(a=>a.id)).toEqual(['a','z']);
  expect(query.data.homeComms.agents).toEqual(['a','z']);
});
it.each(['loading','offline','denied'] as const)('clears retained ownership when the feed is %s', status => {
  expect(deskRoster({...query,status})).toEqual({status,records:[]});
});
it('drops revoked ownership despite visible directory rows and refuses missing current identity',()=>{
  expect(deskRoster({...query,data:{...query.data,agents:[]}}).records).toEqual([]);
  expect(deskRoster({...query,data:{...query.data,homeComms:{member:'sam',agents:[]}}}).records).toEqual([]);
  expect(deskRoster({...query,data:{...query.data,homeComms:null}})).toEqual({status:'denied',records:[]});
  expect(deskRoster({status:'live'})).toEqual({status:'loading',records:[]});
});
