import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as fs from 'node:fs';
import { prepareRunnerBrief, RunnerBriefError, MAX_BRIEF_FILE, MAX_BRIEF_BYTES } from './brief.js';
import { compileBodyRules } from '../pieces/runtime/body-policy.js';

vi.mock('node:fs',async original=>({...await original<typeof import('node:fs')>()}));
const roots:string[]=[];
const temp=()=>{const root=mkdtempSync(join(tmpdir(),'runner-brief-'));roots.push(root);return root;};
const key='a'.repeat(64);
const rules=(sections:unknown[])=>({key,deny:['mcp__private','Bash(rm *)'],sections});
afterEach(()=>{vi.restoreAllMocks();for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});

describe('runner-local compiled brief',()=>{
 it('resolves actual guest compiler output and preserves deny, ordering and exact bytes',async()=>{
  const root=temp();mkdirSync(join(root,'briefs'));
  writeFileSync(join(root,'briefs/guest.md'),'GUEST FLOOR\n');
  writeFileSync(join(root,'briefs/conduct.md'),'CONDUCT\n');
  const compiled=await compileBodyRules({conversation:{agent:'art',venue:'discord',place:'room'},platform:true,
   about:{kind:'dm',venue:'room',members:['guest']},messages:[{from:{kind:'person',slug:'guest'}}],
   gates:{people:{guest:{tier:1},owner:{tier:3}}},policy:{deny:['mcp__private'],guest_deny:['Bash(rm *)'],briefs:{guest:'briefs/guest.md',venues:{discord:'briefs/conduct.md'}}}},async()=> 'Guest card');
  const prepared=prepareRunnerBrief(compiled,root);
  const files:Record<string,string>={'briefs/guest.md':'GUEST FLOOR\n','briefs/conduct.md':'CONDUCT\n'};
  expect(prepared.brief).toBe(compiled.sections.map(s=>'text' in s?s.text:files[s.file]).join(''));
  expect(prepared.brief).toContain('GUEST FLOOR\n');expect(prepared.brief).toContain('Guest card');
  expect(prepared.brief.indexOf('GUEST FLOOR')).toBeLessThan(prepared.brief.indexOf('CONDUCT'));
  expect(prepared.deny).toEqual(compiled.deny);expect(prepared.policyKey).toBe(compiled.key);
  expect(Object.isFrozen(prepared)).toBe(true);expect(Object.isFrozen(prepared.deny)).toBe(true);
 });
 it('supports inline-only rules without a checkout and snapshots caller mutations',()=>{
  const raw=rules([{text:'one\n'},{text:'two'}]),p=prepareRunnerBrief(raw);
  raw.deny.push('more');raw.sections[0]={text:'changed'};
  expect(p.brief).toBe('one\ntwo');expect(p.deny).toHaveLength(2);
 });
 it('changes the resolved history key when required file bytes, order, deny or policy change',()=>{
  const root=temp();writeFileSync(join(root,'floor'),'before');const raw=rules([{file:'floor',what:'floor'}]);
  const before=prepareRunnerBrief(raw,root);expect(prepareRunnerBrief(raw,root).key).toBe(before.key);
  writeFileSync(join(root,'floor'),'after');expect(prepareRunnerBrief(raw,root).key).not.toBe(before.key);
  expect(prepareRunnerBrief({...raw,key:'b'.repeat(64)},root).key).not.toBe(prepareRunnerBrief(raw,root).key);
  expect(prepareRunnerBrief({...raw,deny:[]},root).key).not.toBe(prepareRunnerBrief(raw,root).key);
  expect(prepareRunnerBrief(rules([{text:'a'},{text:'b'}])).key).not.toBe(prepareRunnerBrief(rules([{text:'b'},{text:'a'}])).key);
 });
 it.each(['../outside','/etc/passwd','a/../outside','./floor','a//floor','a\\floor'])('rejects unsafe reference %s',file=>{
  expect(()=>prepareRunnerBrief(rules([{file,what:'floor'}]),temp())).toThrow(RunnerBriefError);
 });
 it.each(['missing','empty','whitespace','oversize','directory','invalid-utf8','nul'])('requires whole valid regular file: %s',kind=>{
  const root=temp(),p=join(root,'floor');
  if(kind==='directory')mkdirSync(p);
  else if(kind!=='missing')writeFileSync(p,kind==='empty'?'':kind==='whitespace'?' \n':kind==='oversize'?'x'.repeat(MAX_BRIEF_FILE+1):kind==='invalid-utf8'?Buffer.from([0xff]):'floor\0');
  expect(()=>prepareRunnerBrief(rules([{file:'floor',what:'floor'}]),root)).toThrow(RunnerBriefError);
 });
 it('accepts exactly the per-file bound and rejects combined oversized inline content',()=>{
  const root=temp();writeFileSync(join(root,'floor'),'x'.repeat(MAX_BRIEF_FILE));
  expect(prepareRunnerBrief(rules([{file:'floor',what:'floor'}]),root).brief).toHaveLength(MAX_BRIEF_FILE);
  expect(()=>prepareRunnerBrief(rules([{text:'x'.repeat(MAX_BRIEF_BYTES)},{text:'y'}]))).toThrow('byte limit');
  expect(()=>prepareRunnerBrief(rules([{text:'é'.repeat(MAX_BRIEF_BYTES)}]))).toThrow('byte limit');
 });
 it('rejects final, intermediate, internal and checkout-root symlinks',()=>{
  const root=temp(),outside=temp();writeFileSync(join(outside,'floor'),'PRIVATE');writeFileSync(join(root,'real'),'inside');
  symlinkSync(join(outside,'floor'),join(root,'file'));symlinkSync(outside,join(root,'dir'));
  symlinkSync(join(root,'real'),join(root,'internal'));symlinkSync(root,join(outside,'root'));
  for(const file of ['file','dir/floor','internal'])expect(()=>prepareRunnerBrief(rules([{file,what:'floor'}]),root)).toThrow(RunnerBriefError);
  expect(()=>prepareRunnerBrief(rules([{file:'real',what:'floor'}]),join(outside,'root'))).toThrow(RunnerBriefError);
  expect(()=>prepareRunnerBrief(rules([{file:'real',what:'floor'}]),join(outside,'root')+'/')).toThrow(RunnerBriefError);
  mkdirSync(join(root,'nested'));writeFileSync(join(root,'nested/floor'),'inside');
  expect(()=>prepareRunnerBrief(rules([{file:'floor',what:'floor'}]),join(outside,'root/nested'))).toThrow(RunnerBriefError);
 });
 it.each(['relative/path','/tmp/../tmp','/tmp/./repo','/tmp//repo','/'])('rejects ambiguous checkout path %s',repo=>{
  expect(()=>prepareRunnerBrief(rules([{file:'floor',what:'floor'}]),repo)).toThrow(RunnerBriefError);
 });
 it('pins opened directories across a replacement with an escaping symlink',()=>{
  const root=temp(),outside=temp();mkdirSync(join(root,'dir'));writeFileSync(join(root,'dir/floor'),'SAFE');writeFileSync(join(outside,'floor'),'PRIVATE');
  const original=fs.openSync;
  vi.spyOn(fs,'openSync').mockImplementation(((p:fs.PathLike,flags:number)=>{
   const fd=original(p,flags);
   if(String(p).endsWith('/dir')){fs.renameSync(join(root,'dir'),join(root,'pinned'));symlinkSync(outside,join(root,'dir'));}
   return fd;
  }) as typeof fs.openSync);
  expect(prepareRunnerBrief(rules([{file:'dir/floor',what:'floor'}]),root).brief).toBe('SAFE');
 });
 it('bounds a file that grows after fstat and closes descriptors on refusal',()=>{
  const root=temp();writeFileSync(join(root,'floor'),'small');const original=fs.readSync;
  const close=vi.spyOn(fs,'closeSync');let grew=false;
  vi.spyOn(fs,'readSync').mockImplementation(((...args:Parameters<typeof fs.readSync>)=>{
   if(!grew){grew=true;writeFileSync(join(root,'floor'),'x'.repeat(MAX_BRIEF_FILE+100));}
   return original(...args);
  }) as typeof fs.readSync);
  expect(()=>prepareRunnerBrief(rules([{file:'floor',what:'floor'}]),root)).toThrow(RunnerBriefError);
  expect(close.mock.calls.length).toBeGreaterThanOrEqual(2);
 });
 it.each(['success','nested failure','checkout failure'])('closes every opened descriptor on %s',kind=>{
  const root=temp();mkdirSync(join(root,'dir'));writeFileSync(join(root,'dir/floor'),'safe');
  const originalOpen=fs.openSync,originalClose=fs.closeSync;
  const live=new Set<number>();
  vi.spyOn(fs,'openSync').mockImplementation(((...args:Parameters<typeof fs.openSync>)=>{
   const fd=originalOpen(...args);expect(live.has(fd)).toBe(false);live.add(fd);return fd;
  }) as typeof fs.openSync);
  vi.spyOn(fs,'closeSync').mockImplementation(fd=>{expect(live.delete(fd)).toBe(true);originalClose(fd);});
  const prepare=()=>prepareRunnerBrief(rules([{file:kind==='nested failure'?'dir/missing/floor':'dir/floor',what:'floor'}]),kind==='checkout failure'?join(root,'missing/nested'):root);
  if(kind==='success')expect(prepare().brief).toBe('safe');else expect(prepare).toThrow(RunnerBriefError);
  expect(live.size).toBe(0);
 });
 it('rejects absent checkout, ambiguous sections, oversized arrays and malformed policy identity',()=>{
  for(const raw of [rules([{file:'floor',what:'floor'}]),rules([{text:'hi',file:'floor'}]),rules([]),rules(Array.from({length:41},()=>({text:'a'}))),{...rules([{text:'a'}]),key:'body-chosen'}])
   expect(()=>prepareRunnerBrief(raw)).toThrow(RunnerBriefError);
 });
});
