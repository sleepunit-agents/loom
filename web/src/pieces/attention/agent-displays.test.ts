import { expect, it } from 'vitest';
import { deskAgentDisplays } from './agent-displays';
const query={status:'live' as const,data:{agents:[{id:'art',markBg:'#123456',markFg:'#ffffff',faceShape:'drop' as const,faceEyes:'oval' as const}]}};
it('adapts only the shared drawn face fields, without inventing pixel metadata',()=>{
 expect(deskAgentDisplays(query)).toEqual([{id:'art',agent:'art',mark:{bg:'#123456',fg:'#ffffff'},face:{shape:'drop',eyes:'oval'}}]);
 expect(deskAgentDisplays(query)[0]).not.toHaveProperty('sprite');
});
it.each(['loading','offline','denied'] as const)('withdraws retained face metadata on %s',status=>{
 expect(deskAgentDisplays({...query,status})).toEqual([]);
});
it('returns neutral fallback data for absent or live empty selections',()=>{
 expect(deskAgentDisplays({status:'live'})).toEqual([]);
 expect(deskAgentDisplays({status:'live',data:{agents:[]}})).toEqual([]);
});
