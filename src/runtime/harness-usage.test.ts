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
