import {readFileSync} from 'node:fs';
import {expect,it} from 'vitest';
import {claudeUsage,codexUsage} from './harness-usage.js';

const rows=(name:string)=>JSON.parse(readFileSync(new URL('../../test/fixtures/usage/'+name+'.json',import.meta.url),'utf8'));
it('measures Claude inclusive input and the largest actual input, including both cache buckets',()=>{
 expect(claudeUsage(rows('claude'))).toMatchObject({source:'report',tokensIn:4288,tokensOut:4,cacheRead:649,cacheWritten:3637,modelCalls:1,largestContext:4288,tools:{},toolCalls:0});
});
it('reads Codex inclusive input once, counts a completed command once, and leaves unreported measures unknown',()=>{
 expect(codexUsage(rows('codex'))).toMatchObject({source:'report',tokensIn:36559,tokensOut:95,cacheRead:24320,cacheWritten:0,toolCalls:1,tools:{command_execution:1},modelCalls:null,largestContext:null});
});
it('uses the last usage for a repeated Claude message id when the aggregate is missing',()=>{
 const [assistant]=rows('claude');
 expect(claudeUsage([assistant,assistant])).toMatchObject({source:'transcript',tokensIn:4288,tokensOut:4,modelCalls:1});
});
it('keeps missing Codex counters unknown',()=>{
 expect(codexUsage([{type:'turn.completed',usage:{output_tokens:0}}])).toMatchObject({tokensIn:null,tokensOut:0,cacheWritten:null});
});

it('discards malformed end reports without changing the harness reply',()=>{
 expect(codexUsage([{type:'turn.completed',usage:{input_tokens:-10,output_tokens:4}}])).toEqual({source:'none'});
 expect(claudeUsage([{type:'result',usage:'malformed'}])).toEqual({source:'none'});
});

it('uses each distinct call when the result lists only the last iteration',()=>{
 const [assistant,result]=rows('claude');
 const second={...assistant,message:{...assistant.message,id:'second',usage:{...assistant.message.usage,input_tokens:1}}};
 expect(claudeUsage([assistant,second,result])).toMatchObject({modelCalls:2,largestContext:4288});
});

it('keeps valid transcript calls when the end report contains malformed iteration detail',()=>{
 const [assistant,result]=rows('claude');
 result.usage.iterations=[null,null];
 expect(claudeUsage([assistant,result])).toMatchObject({source:'report',modelCalls:1,largestContext:4288});
});

it('keeps result-only context measurements without inventing a zero tool count',()=>{
 const [,result]=rows('claude');
 expect(claudeUsage([result])).toMatchObject({source:'report',modelCalls:1,largestContext:4288,toolCalls:null,tools:null});
});

it('counts repeated Codex tool events once per id and includes an interrupted call', () => {
 const event = (type:string,id:string) => ({type,item:{type:'mcp_tool_call',id,tool:'recall'}});
 expect(codexUsage([event('item.started','a'),event('item.completed','a'),event('item.completed','a'),event('item.started','b')]))
  .toMatchObject({source:'transcript',tools:{recall:2},toolCalls:2});
});

it('records the first parent call independently of later calls and nested agents',()=>{
 const [assistant,result]=rows('claude');
 const child={...assistant,agent_id:'nested',message:{...assistant.message,id:'child',usage:{...assistant.message.usage,input_tokens:8000}}};
 const later={...assistant,message:{...assistant.message,id:'later',usage:{...assistant.message.usage,input_tokens:9000}}};
 expect(claudeUsage([child,assistant,later,result])).toMatchObject({firstContext:4288,largestContext:13286});
 const reusedChild={...child,message:{...child.message,id:assistant.message.id}};
 expect(claudeUsage([assistant,reusedChild,result]).firstContext).toBe(4288);
 for(const placeholder of [{...assistant,error:'api'},{...assistant,aborted:true},{...assistant,message:{...assistant.message,model:'<synthetic>'}}])
  expect(claudeUsage([placeholder,later,result]).firstContext).toBeUndefined();
 expect(claudeUsage([result]).firstContext).toBeUndefined();
 expect(claudeUsage([{...assistant,message:{...assistant.message,id:undefined}},later,result]).firstContext).toBeUndefined();
});
