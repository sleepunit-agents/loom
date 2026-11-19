import {describe, expect, it} from 'vitest';
import {kitArguments,kitTool,kitTools} from './kit-manifest.js';

const tool = {name:'check_mail',description:'Check mail for a sender',program:'tools/mail',commit:'1'.repeat(40),
  repository:'https://example.com/house.git',image:'sha256:'+'a'.repeat(64),parameters:{sender:{type:'string',description:'Sender'}},
  args:['--sender',{parameter:'sender'}],secrets:{KIT_MAIL_KEY:'mail-key'}};

describe('kit tool manifest',()=>{
  it('expands only whole typed slots and never interprets punctuation',()=>{
    const manifest=kitTool.parse(tool);
    const sender='a b; echo $(date) -q "x"';
    expect(kitArguments(manifest,{sender})).toEqual(['--sender',sender]);
    for(const args of [{sender:0},{sender:'x',extra:1},{sender:'\0'},{sender:'--help'},{sender:'../x'},{sender:'foo\nbar'},{}])expect(()=>kitArguments(manifest,args)).toThrow();
  });
  it('rejects unpinned code, paths outside the house, ambient environment controls and unknown placeholders',()=>{
    for(const change of [{image:'latest'},{commit:'main'},{repository:'file:///tmp/private'},{program:'../mail'},{program:'/bin/sh'},
      {secrets:{LD_PRELOAD:'x'}},{args:[{parameter:'unknown'}]},{argv:['free']}])expect(kitTool.safeParse({...tool,...change}).success).toBe(false);
    expect(kitTools.safeParse([tool,tool]).success).toBe(false);
  });
});
