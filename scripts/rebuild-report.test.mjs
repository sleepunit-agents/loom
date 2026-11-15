import {it,expect} from 'vitest';
import {evaluate} from './rebuild-report.mjs';
const promise={probe:{kind:'ui',app:'Tasks',contains:['Claim','Close']}};
it('never counts an open tile or a claim button as proof that its actions work',()=>{
 expect(evaluate({promise:'Claiming changes task state.'},{apps:[]} ).status).toBe('not checkable yet');
 expect(evaluate(promise,{apps:[{title:'Tasks',opened:true,text:'Claim'}]}).status).toBe('not met');
 expect(evaluate(promise,{apps:[{title:'Tasks',opened:true,text:'Claim Close'}]}).status).toBe('met');
});
it('does not turn missing apps or failed sign-in into a pass',()=>{
 expect(evaluate(promise,{apps:[]}).status).toBe('not met');
 expect(evaluate(promise,{apps:[],fatal:'Sign-in failed'}).status).toBe('not checkable yet');
 expect(evaluate({probe:{kind:'signin'}},{signin:{ok:false}}).status).toBe('not met');
});
it('requires actual GraphQL data and no GraphQL errors for the live observation',()=>{
 const promise={probe:{kind:'live'}};
 expect(evaluate(promise,{live:{dataFrames:0,errors:[]}}).status).toBe('not met');
 expect(evaluate(promise,{live:{dataFrames:1,errors:['bad query']}}).status).toBe('not met');
 expect(evaluate(promise,{live:{dataFrames:1,errors:[]}}).status).toBe('met');
});
it('requires completed behavioral evidence rather than visible controls',()=>{
 const promise={probe:{kind:'action',app:'Tempo',check:'held'}};
 expect(evaluate(promise,{apps:[{title:'Tempo',opened:true,text:'Pause agent'}]}).status).toBe('not met');
 expect(evaluate(promise,{apps:[],fatal:'Startup failed'}).status).toBe('not checkable yet');
 expect(evaluate(promise,{apps:[{title:'Tempo',actions:{held:{ok:false,error:'fired while paused'}}}]})).toMatchObject({status:'not met',reason:'fired while paused'});
 expect(evaluate(promise,{apps:[{title:'Tempo',actions:{held:{ok:true,facts:{state:'held'},evidence:'tempo-held.png'}}}]})).toMatchObject({status:'met',evidence:'tempo-held.png'});
});
