import {EventEmitter} from 'node:events';
import {PassThrough,Writable} from 'node:stream';
import type {ChildProcessWithoutNullStreams} from 'node:child_process';
import { expect, it, vi } from 'vitest';
import { claudeBody } from './claude-body.js';
import { bodyHarness } from './body-harnesses.js';
import {nativeClaudeFixture as fixture} from '../../test/fixtures/native-claude.js';
import type { WorkerAssignment } from './worker.js';
const job: WorkerAssignment = { id: 'j', box: 'b', agent: 'art', conversation: 'cv', model: 'requested-model', account: 'sub', harness: 'claude', brief: '', house: { repository: 'r', file: 'Containerfile', branch: 'next' },
  run: { nestedContainers: false, gpu: false, ports: [], policy: { people: [], deniedTools: [{ pattern: 'Read', guestsOnly: false }, { pattern: 'Bash(*)', guestsOnly: true }] } } };

it('selects the requested model, denies native tools, and reports response models instead of init/request/usage guesses', async () => {
  const f = fixture(), result = f.run(job, 'PRIVATE ACCEPTED MAIL', f.abort.signal); f.env.ACCOUNT_PROFILE = '/changed';
  const args = f.launch.mock.calls[0][1];
  expect(args).toContain('--no-session-persistence'); expect(args).toContain('--strict-mcp-config'); expect(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2)).toEqual(['--model', 'requested-model']);
  expect(args.slice(args.indexOf('--disallowedTools'))).toEqual(['--disallowedTools', 'Read']);
  expect(f.launch.mock.calls[0][2]).toEqual({ cwd: '/house', env: { PATH: '/usr/bin', ACCOUNT_PROFILE: '/private/account' }, shell: false, detached: false, stdio: 'pipe' });
  expect(JSON.stringify(f.launch.mock.calls)).not.toContain('PRIVATE ACCEPTED MAIL'); expect(f.words()).toBe('PRIVATE ACCEPTED MAIL');
  f.finish(f.rows([{ type: 'assistant', parent_tool_use_id: null, message: { model: 'tool-model', content: [{ type: 'tool_use', name: 'Edit' }] } }]));
  expect(await result).toEqual({ text: 'Answer é', model: 'observed-model', actions: [{ model: 'tool-model' }] });
});
it.each([1, 2, null] as const)('applies guest-only native denials for tier %s', async tier => {
  const f = fixture(), configured = structuredClone(job); configured.run!.policy!.people = [{ kind: 'outside', person: 'outside-key', tier }];
  const result = f.run(configured, 'mail', f.abort.signal); expect(f.launch.mock.calls[0][1].slice(-3)).toEqual(['--disallowedTools', 'Read', 'Bash(*)']); f.finish(f.rows()); await result;
});
it.each(['requested-only', 'mismatch', 'foreign-session', 'error', 'synthetic', 'subagent', 'aborted', 'invalid-json', 'invalid-utf8', 'overflow'] as const)('refuses %s native output without a guessed response', async mode => {
  const f = fixture(), result = f.run(job, 'mail', f.abort.signal), rows = f.rows();
  if (mode === 'requested-only') rows.splice(1, 1);
  if (mode === 'mismatch') Object.assign(rows[2], {result:'different result'});
  if (mode === 'foreign-session') rows[1].session_id = 'another';
  if (mode === 'error') Object.assign(rows[1], { error: 'authentication_failed' });
  if (mode === 'synthetic') Object.assign(rows[1], {message:{model:'<synthetic>',content:[]}});
  if (mode === 'subagent') Object.assign(rows[1], { parent_tool_use_id: 'tool' });
  if (mode === 'aborted') Object.assign(rows[1], { aborted: true });
  if (mode === 'invalid-utf8') { (f.child.stdout as PassThrough).write(Buffer.from([0xff])); f.child.emit('close', 0); }
  else f.finish(mode === 'invalid-json' ? '{bad' : mode === 'overflow' ? 'x'.repeat(1_048_577) : rows);
  await expect(result).rejects.toThrow('Native execution unavailable');
});
it('cancels a running native child and refuses a late success', async () => {
  const f = fixture(), result = f.run(job, 'mail', f.abort.signal); f.abort.abort(); f.finish(f.rows()); await expect(result).rejects.toThrow(); expect(f.child.kill).toHaveBeenCalledWith('SIGKILL');
});
it.each(['model-option', 'tool-option', 'harness', 'pre-abort'] as const)('rejects %s before spawn or input release', async mode => {
  const f = fixture(), changed = structuredClone(job);
  if (mode === 'model-option') changed.model = '--help';
  if (mode === 'tool-option') changed.run!.policy!.deniedTools[0].pattern = '--allowedTools';
  if (mode === 'harness') changed.harness = 'codex';
  if (mode === 'pre-abort') f.abort.abort();
  // Through the registry, as the body program runs it: that is where a job for another harness is refused.
  const run = bodyHarness('claude', { command: '/private/claude', cwd: '/house', env: f.env, spawn: f.launch });
  await expect(run(changed, 'mail', f.abort.signal)).rejects.toThrow(/^Native execution unavailable$/); expect(f.launch).not.toHaveBeenCalled();
});

it('does not classify authenticated household people as guests from a missing outside tier', async () => {
  const f = fixture(), configured = structuredClone(job); configured.run!.policy!.people = [{kind:'person',person:'household-member',tier:null}];
  const result = f.run(configured,'mail',f.abort.signal); expect(f.launch.mock.calls[0][1].slice(-2)).toEqual(['--disallowedTools','Read']); f.finish(f.rows()); await result;
});

it('keeps guest-only tools available for an outside sender with configured tier three',async()=>{
 const f=fixture(),configured=structuredClone(job);configured.run!.policy!.people=[{kind:'outside',person:'outside-key',tier:3}];
 const result=f.run(configured,'mail',f.abort.signal);expect(f.launch.mock.calls[0][1].slice(-2)).toEqual(['--disallowedTools','Read']);f.finish(f.rows());await result;
});

it('erases original native stdout/stderr buffers and late output after cancellation',async()=>{
 const f=fixture(),pending=f.run(job,'mail',f.abort.signal),output=Buffer.from(f.rows().map(row=>JSON.stringify(row)).join('\n')),diagnostic=Buffer.from('body_'+'f'.repeat(64));
 f.child.stdout.emit('data',output);f.child.stderr.emit('data',diagnostic);
 expect(output.every(byte=>byte===0)).toBe(true);expect(diagnostic.every(byte=>byte===0)).toBe(true);
 f.abort.abort();const lateOut=Buffer.from('PRIVATE LATE OUTPUT'),lateError=Buffer.from('PRIVATE LATE ERROR');
 f.child.stdout.emit('data',lateOut);f.child.stderr.emit('data',lateError);
 await expect(pending).rejects.toThrow('Native execution unavailable');
 expect(lateOut.every(byte=>byte===0)).toBe(true);expect(lateError.every(byte=>byte===0)).toBe(true);
});
it('snapshots private MCP config to descriptor 3, erases its pipe bytes, and permits only its two tools',async()=>{
 const f=fixture(),secret='PRIVATE_LOCAL_CAPABILITY',input=Buffer.from(JSON.stringify({mcpServers:{loom_secrets:{type:'http',url:'http://127.0.0.1:1234',headers:{Authorization:secret}}}})),chunks:Buffer[]=[];let text='';
 const pipe=new Writable({write(chunk,_encoding,done){chunks.push(chunk);text+=chunk.toString();done();}}),finished=new Promise<void>(resolve=>pipe.once('finish',resolve));Object.assign(f.child,{stdio:[null,null,null,pipe]});
 const run=claudeBody({command:'/private/claude',cwd:'/house',env:f.env,spawn:f.launch,mcpConfig:input});input.fill(0);const result=run(job,'PRIVATE ACCEPTED MAIL',f.abort.signal);await finished;
 expect(JSON.parse(text).mcpServers.loom_secrets.headers.Authorization).toBe(secret);expect(chunks.length).toBeGreaterThan(0);expect(chunks.every(bytes=>bytes.every(byte=>byte===0))).toBe(true);
 const args=f.launch.mock.calls[0][1],options=f.launch.mock.calls[0][2];expect(args[args.indexOf('--mcp-config')+1]).toBe('/dev/fd/3');expect(args.slice(args.indexOf('--allowedTools'),args.indexOf('--disallowedTools'))).toEqual(['--allowedTools','mcp__loom_secrets__request_secret','mcp__loom_secrets__use_secret']);expect(options.stdio).toEqual(['pipe','pipe','pipe','pipe']);expect(f.launch.mock.calls[0][0]).toBe('/bin/bash');expect(args.slice(0,7)).toEqual(['--noprofile','--norc','-p','-c','exec 3< <(/bin/cat <&3); exec "$@"','loom-native','/private/claude']);expect(JSON.stringify({args,options})).not.toContain(secret);expect(f.words()).toBe('PRIVATE ACCEPTED MAIL');expect(f.env).toEqual({PATH:'/usr/bin',ACCOUNT_PROFILE:'/private/account'});
 f.finish(f.rows());await result;await expect(run(job,'again',f.abort.signal)).rejects.toThrow('Native execution unavailable');expect(f.launch).toHaveBeenCalledOnce();
});
it('erases an unsettled private MCP pipe at cancellation before its write callback runs',async()=>{
 const f=fixture(),chunks:Buffer[]=[];let release!:()=>void;const pipe=new Writable({write(chunk,_encoding,done){chunks.push(chunk);release=done;}});Object.assign(f.child,{stdio:[null,null,null,pipe]});
 const run=claudeBody({command:'/private/claude',cwd:'/house',env:f.env,spawn:f.launch,mcpConfig:Buffer.from('{"private":"LOCAL_CAPABILITY"}')});const result=run(job,'mail',f.abort.signal),refused=expect(result).rejects.toThrow('Native execution unavailable');f.abort.abort();expect(chunks).toHaveLength(1);expect(chunks.every(bytes=>bytes.every(byte=>byte===0))).toBe(true);await refused;release();
});
it('snapshots composed private tool names without broadening denied native tools',async()=>{
 const f=fixture(),names=['mcp__loom_secrets__command'],pipe=new Writable({write(_chunk,_encoding,done){done();}});Object.assign(f.child,{stdio:[null,null,null,pipe]});
 const run=claudeBody({command:'/private/claude',cwd:'/house',env:f.env,spawn:f.launch,mcpConfig:Buffer.from('{}'),mcpTools:names});names.push('Bash');const pending=run(job,'mail',f.abort.signal),args=f.launch.mock.calls[0][1];
 expect(args.slice(args.indexOf('--allowedTools'),args.indexOf('--disallowedTools'))).toEqual(['--allowedTools','mcp__loom_secrets__command']);expect(args.slice(args.indexOf('--disallowedTools'))).toEqual(['--disallowedTools','Read']);f.finish(f.rows());await pending;
});
it.each([{names:[{toString:()=> 'mcp__loom_secrets__command'} as unknown as string]},{names:['Bash']},{names:['mcp__foreign__tool']},{names:['mcp__loom_secrets__command','mcp__loom_secrets__command']}])('refuses invalid private tool policy $names before launching',({names})=>{
 const f=fixture();expect(()=>claudeBody({command:'/private/claude',cwd:'/house',env:f.env,spawn:f.launch,mcpConfig:Buffer.from('{}'),mcpTools:names})).toThrow('Native execution unavailable');expect(f.launch).not.toHaveBeenCalled();
});
it('refuses private tool names without a private MCP configuration before launch',()=>{
 const f=fixture();expect(()=>claudeBody({command:'/private/claude',cwd:'/house',env:f.env,spawn:f.launch,mcpTools:['mcp__loom_secrets__command']})).toThrow('Native execution unavailable');expect(f.launch).not.toHaveBeenCalled();
});
it('gives a body the harness\'s own tools only when the machine says so, and still withholds denied tools', async () => {
  const f = fixture();
  const full = claudeBody({ command: '/private/claude', cwd: '/house', env: f.env, spawn: f.launch, reach: 'all' });
  const result = full(job, 'mail', f.abort.signal); const args = f.launch.mock.calls[0][1];
  expect(args[args.indexOf('--permission-mode') + 1]).toBe('bypassPermissions');
  expect(args).not.toContain('--allowedTools');
  expect(args.slice(args.indexOf('--disallowedTools'))).toEqual(['--disallowedTools', 'Read']);
  f.finish(f.rows()); await result.catch(() => {});
  const g = fixture(), plain = g.run(job, 'mail', g.abort.signal);
  expect(g.launch.mock.calls[0][1][g.launch.mock.calls[0][1].indexOf('--permission-mode') + 1]).toBe('dontAsk');
  g.finish(g.rows()); await plain.catch(() => {});
});
