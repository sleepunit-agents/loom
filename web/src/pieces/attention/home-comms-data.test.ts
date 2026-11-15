import { expect, it } from 'vitest';
import { homeComms, type HomeCommsData } from './home-comms-data';
const data:HomeCommsData={homeComms:{member:'owner',agents:['art'],summaries:[{agent:'art',unread:102,last:{thread:'th:last',title:'Latest',at:'2026-11-14T00:00:00.500Z'},first:{thread:'th:unread'}}]}};
it('keeps server aggregate counts, exact destinations and authenticated compose identity',()=>{
 expect(homeComms({status:'live',data})).toEqual({status:'live',reading:{member:'owner',agents:['art'],summaries:[{agent:'art',unread:102,last:{thread:'th:last',title:'Latest',at:Date.parse('2026-11-14T00:00:00.500Z')},first:{thread:'th:unread'}}]}});
 expect(homeComms({status:'live',data:{homeComms:{member:'other',agents:[],summaries:[]}}})).toEqual({status:'live',reading:{member:'other',agents:[],summaries:[]}});
});
it.each(['loading','offline','denied'] as const)('clears retained member, compose agents and summary when %s',status=>{
 expect(homeComms({status,data})).toEqual({status});
});
it('distinguishes unavailable identity from a live mailbox with no conversations',()=>{
 expect(homeComms({status:'live',data:{homeComms:null}})).toEqual({status:'denied'});
 expect(homeComms({status:'live'})).toEqual({status:'loading'});
 expect(homeComms({status:'live',data:{homeComms:{member:'owner',agents:['art'],summaries:[{agent:'art',unread:0,last:null,first:null}]}}}).reading?.summaries).toEqual([{agent:'art',unread:0,last:undefined,first:undefined}]);
});
