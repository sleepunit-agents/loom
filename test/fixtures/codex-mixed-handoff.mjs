#!/usr/bin/env node
// A deterministic Codex exec stream for a role job with internal native work.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const prompt=readFileSync(0,'utf8');
assert.match(prompt,/Read commit abc\./);
assert.match(prompt,/Compare the cited documents\./);
assert.equal(process.argv[2],'exec');
assert.equal(process.argv[process.argv.indexOf('-m')+1],'reviewer');
function emit(type,fields={}) {
  process.stdout.write(JSON.stringify({type,...fields})+'\n');
}
emit('thread.started',{thread_id:'synthetic'});
emit('turn.started');
for(const [id,tool,status] of [
  ['a','spawn_agent','completed'],['b','spawn_agent','completed'],['c','spawn_agent','completed'],
  ['d','spawn_agent','failed'],['e','wait','completed'],
]){
  const item={id,type:'collab_tool_call',tool};
  emit('item.started',{item:{...item,status:'in_progress'}});
  emit('item.completed',{item:{...item,status}});
}
emit('item.completed',{item:{id:'answer',type:'agent_message',text:'PRIVATE REVIEW FINDINGS'}});
emit('turn.completed',{usage:{input_tokens:1200,output_tokens:85,cached_input_tokens:400}});
