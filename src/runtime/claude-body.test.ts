import {EventEmitter} from 'node:events';
import {PassThrough,Writable} from 'node:stream';
import type {ChildProcessWithoutNullStreams} from 'node:child_process';
import { expect, it, vi } from 'vitest';
import { claudeBody } from './claude-body.js';
import { HarnessResumeUnavailable } from './body-harness.js';
import { bodyHarness } from './body-harnesses.js';
import {nativeClaudeFixture as fixture} from '../../test/fixtures/native-claude.js';
import type { WorkerAssignment } from './worker.js';
import { bodyNamedToolNames } from './body-named-tools.js';
const job: WorkerAssignment = { id: 'j', box: 'b', agent: 'art', conversation: 'cv', model: 'requested-model', account: 'sub', harness: 'claude', brief: '', house: { repository: 'r', file: 'Containerfile', branch: 'next' },
  run: { nestedContainers: false, gpu: false, ports: [], policy: { word: 'owners', people: [], deniedTools: [{ pattern: 'Read', guestsOnly: false }, { pattern: 'Bash(*)', guestsOnly: true }] } } };

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
  const f = fixture(), configured = structuredClone(job); configured.run!.policy!.people = [{ kind: 'outside', person: 'outside-key', tier }]; configured.run!.policy!.word = 'others';
  const result = f.run(configured, 'mail', f.abort.signal); expect(f.launch.mock.calls[0][1].slice(-3)).toEqual(['--disallowedTools', 'Read', 'Bash(*)']); f.finish(f.rows()); await result;
});
it('starts no harness for a denial whose later entry would be read as an option', async () => {
  // The store refuses a pattern that begins with a dash. One that hides the dash behind a comma is refused here.
  const f = fixture(), configured = structuredClone(job); configured.run!.policy!.deniedTools = [{ pattern: 'Read,--dangerously-skip-permissions', guestsOnly: false }];
  await expect(f.run(configured, 'mail', f.abort.signal)).rejects.toThrow('Native execution unavailable'); expect(f.launch).not.toHaveBeenCalled();
});
it.each(['mcp__loom__loom_command', 'mcp__loom_secrets__loom_query', 'Bash,mcp__loom__loom_query', 'Read mcp__loom_secrets__loom_command'])('denies every named tool in a shared place that is denied the generic tool under it: %s', async pattern => {
  // An owner's rule may be for guests only, and may have been stored when the tools server had its old name.
  const f = fixture(), configured = structuredClone(job);
  configured.run!.policy!.people = [{ kind: 'outside', person: 'outside-key', tier: 1 }]; configured.run!.policy!.word = 'others';
  configured.run!.policy!.deniedTools = [{ pattern, guestsOnly: true }];
  const result = f.run(configured, 'mail', f.abort.signal), args = f.launch.mock.calls[0][1], denied = args.slice(args.indexOf('--disallowedTools') + 1);
  // Each entry is its own argument, so the harness has nothing left to split; the generic tool is named as it is called now.
  const generic = 'mcp__loom__' + /loom_(?:command|query)$/.exec(pattern)![0];
  expect(denied).toEqual([...new Set([...pattern.split(/[ ,]/), generic, ...bodyNamedToolNames().map(name => 'mcp__loom__' + name)])]);
  expect(denied.every(entry => !/[ ,]/.test(entry))).toBe(true);
  expect(denied).toEqual(expect.arrayContaining(['mcp__loom__remember', 'mcp__loom__forget', 'mcp__loom__task_close', 'mcp__loom__recall']));
  f.finish(f.rows()); await result;
  // The same rule with no guest in the room denies nothing.
  const g = fixture(), household = structuredClone(configured); household.run!.policy!.people = []; household.run!.policy!.word = 'owners';
  const quiet = g.run(household, 'mail', g.abort.signal); expect(g.launch.mock.calls[0][1]).not.toContain('--disallowedTools'); g.finish(g.rows()); await quiet;
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

it('goes by the job\'s word and not by a tier: an outside sender of tier three is anybody else, and guest-only denials apply',async()=>{
 const f=fixture(),configured=structuredClone(job);configured.run!.policy!.people=[{kind:'outside',person:'outside-key',tier:3}];configured.run!.policy!.word='others';
 const result=f.run(configured,'mail',f.abort.signal);expect(f.launch.mock.calls[0][1].slice(-3)).toEqual(['--disallowedTools','Read','Bash(*)']);f.finish(f.rows());await result;
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
 const f=fixture(),secret='PRIVATE_LOCAL_CAPABILITY',input=Buffer.from(JSON.stringify({mcpServers:{loom:{type:'http',url:'http://127.0.0.1:1234',headers:{Authorization:secret}}}})),chunks:Buffer[]=[];let text='';
 const pipe=new Writable({write(chunk,_encoding,done){chunks.push(chunk);text+=chunk.toString();done();}}),finished=new Promise<void>(resolve=>pipe.once('finish',resolve));Object.assign(f.child,{stdio:[null,null,null,pipe]});
 const run=claudeBody({command:'/private/claude',cwd:'/house',env:f.env,spawn:f.launch,mcpConfig:input});input.fill(0);const result=run(job,'PRIVATE ACCEPTED MAIL',f.abort.signal);await finished;
 expect(JSON.parse(text).mcpServers.loom.headers.Authorization).toBe(secret);expect(chunks.length).toBeGreaterThan(0);expect(chunks.every(bytes=>bytes.every(byte=>byte===0))).toBe(true);
 const args=f.launch.mock.calls[0][1],options=f.launch.mock.calls[0][2];expect(args[args.indexOf('--mcp-config')+1]).toBe('/dev/fd/3');expect(args.slice(args.indexOf('--allowedTools'),args.indexOf('--disallowedTools'))).toEqual(['--allowedTools','mcp__loom__request_secret','mcp__loom__use_secret']);expect(options.stdio).toEqual(['pipe','pipe','pipe','pipe']);expect(f.launch.mock.calls[0][0]).toBe('/bin/bash');expect(args.slice(0,7)).toEqual(['--noprofile','--norc','-p','-c','exec 3< <(/bin/cat <&3); exec "$@"','loom-native','/private/claude']);expect(JSON.stringify({args,options})).not.toContain(secret);expect(f.words()).toBe('PRIVATE ACCEPTED MAIL');expect(f.env).toEqual({PATH:'/usr/bin',ACCOUNT_PROFILE:'/private/account'});
 f.finish(f.rows());await result;await expect(run(job,'again',f.abort.signal)).rejects.toThrow('Native execution unavailable');expect(f.launch).toHaveBeenCalledOnce();
});
it('erases an unsettled private MCP pipe at cancellation before its write callback runs',async()=>{
 const f=fixture(),chunks:Buffer[]=[];let release!:()=>void;const pipe=new Writable({write(chunk,_encoding,done){chunks.push(chunk);release=done;}});Object.assign(f.child,{stdio:[null,null,null,pipe]});
 const run=claudeBody({command:'/private/claude',cwd:'/house',env:f.env,spawn:f.launch,mcpConfig:Buffer.from('{"private":"LOCAL_CAPABILITY"}')});const result=run(job,'mail',f.abort.signal),refused=expect(result).rejects.toThrow('Native execution unavailable');f.abort.abort();expect(chunks).toHaveLength(1);expect(chunks.every(bytes=>bytes.every(byte=>byte===0))).toBe(true);await refused;release();
});
it('snapshots composed private tool names without broadening denied native tools',async()=>{
 const f=fixture(),names=['mcp__loom__command'],pipe=new Writable({write(_chunk,_encoding,done){done();}});Object.assign(f.child,{stdio:[null,null,null,pipe]});
 const run=claudeBody({command:'/private/claude',cwd:'/house',env:f.env,spawn:f.launch,mcpConfig:Buffer.from('{}'),mcpTools:names});names.push('Bash');const pending=run(job,'mail',f.abort.signal),args=f.launch.mock.calls[0][1];
 expect(args.slice(args.indexOf('--allowedTools'),args.indexOf('--disallowedTools'))).toEqual(['--allowedTools','mcp__loom__command']);expect(args.slice(args.indexOf('--disallowedTools'))).toEqual(['--disallowedTools','Read']);f.finish(f.rows());await pending;
});
it.each([{names:[{toString:()=> 'mcp__loom__command'} as unknown as string]},{names:['Bash']},{names:['mcp__foreign__tool']},{names:['mcp__loom__command','mcp__loom__command']}])('refuses invalid private tool policy $names before launching',({names})=>{
 const f=fixture();expect(()=>claudeBody({command:'/private/claude',cwd:'/house',env:f.env,spawn:f.launch,mcpConfig:Buffer.from('{}'),mcpTools:names})).toThrow('Native execution unavailable');expect(f.launch).not.toHaveBeenCalled();
});
it('refuses private tool names without a private MCP configuration before launch',()=>{
 const f=fixture();expect(()=>claudeBody({command:'/private/claude',cwd:'/house',env:f.env,spawn:f.launch,mcpTools:['mcp__loom__command']})).toThrow('Native execution unavailable');expect(f.launch).not.toHaveBeenCalled();
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
it('keeps a session only when asked to, and reports the id every event carried', async () => {
  const f = fixture(), result = f.run(job, 'mail', f.abort.signal, {});
  const args = f.launch.mock.calls[0][1];
  expect(args).not.toContain('--no-session-persistence'); expect(args).not.toContain('--resume');
  const id = args[args.indexOf('--session-id') + 1];
  f.finish(f.rows());
  expect(await result).toMatchObject({ text: 'Answer é', session: id });
});
it('continues a session by its id, with no new id of its own, and takes the id the harness reports', async () => {
  const f = fixture(), result = f.run(job, 'only the new mail', f.abort.signal, { resume: 'earlier-session-1' });
  const args = f.launch.mock.calls[0][1];
  expect(args.slice(args.indexOf('--resume'), args.indexOf('--resume') + 2)).toEqual(['--resume', 'earlier-session-1']);
  expect(args).not.toContain('--session-id'); expect(args).not.toContain('--no-session-persistence');
  const rows = (id: string) => [{ type: 'system', subtype: 'init', session_id: id }, { type: 'assistant', parent_tool_use_id: null, session_id: id, message: { model: 'observed-model', content: [{ type: 'text', text: 'Go on' }] } }, { type: 'result', subtype: 'success', is_error: false, session_id: id, result: 'Go on' }];
  f.finish(rows('earlier-session-1'));
  expect(await result).toEqual({ text: 'Go on', model: 'observed-model', actions: [], session: 'earlier-session-1' });
  // A harness that gives the continued session another id is believed, so long as every event agrees.
  const forked = fixture(), second = forked.run(job, 'mail', forked.abort.signal, { resume: 'earlier-session-1' });
  forked.finish(rows('forked-session-2'));
  expect(await second).toMatchObject({ session: 'forked-session-2' });
  const mixed = fixture(), third = mixed.run(job, 'mail', mixed.abort.signal, { resume: 'earlier-session-1' });
  const bad = rows('earlier-session-1'); bad[2].session_id = 'another-session';
  mixed.finish(bad);
  await expect(third).rejects.toThrow('Native execution unavailable');
});
it('says a session could not be continued only when the harness ended having said nothing', async () => {
  const silent = fixture(), first = silent.run(job, 'mail', silent.abort.signal, { resume: 'earlier-session-1' });
  (silent.child.stdout as PassThrough).write(JSON.stringify({ type: 'result', subtype: 'error', is_error: true, session_id: 'x' })); silent.child.emit('close', 1);
  await expect(first).rejects.toBeInstanceOf(HarnessResumeUnavailable);
  // Once the model has spoken, a failure is a failure: the work is not run a second time.
  const spoke = fixture(), second = spoke.run(job, 'mail', spoke.abort.signal, { resume: 'earlier-session-1' });
  (spoke.child.stdout as PassThrough).write(JSON.stringify({ type: 'assistant', parent_tool_use_id: null, session_id: 'earlier-session-1', message: { model: 'm', content: [{ type: 'tool_use', name: 'Bash' }] } }) + '\n'); spoke.child.emit('close', 1);
  const failure = await second.catch((error: unknown) => error);
  expect(failure).not.toBeInstanceOf(HarnessResumeUnavailable); expect((failure as Error).message).toBe('Native execution unavailable');
  // A fresh run that fails is a plain failure too, and an id that could be a path is never passed on.
  const fresh = fixture(), third = fresh.run(job, 'mail', fresh.abort.signal, {});
  fresh.child.emit('close', 1);
  expect(await third.catch((error: unknown) => error)).not.toBeInstanceOf(HarnessResumeUnavailable);
  const unsafe = fixture();
  await expect(unsafe.run(job, 'mail', unsafe.abort.signal, { resume: '../../etc/passwd' })).rejects.toThrow('Native execution unavailable');
  expect(unsafe.launch).not.toHaveBeenCalled();
});
it('knows the model spoke when the marker of its event is cut across two pieces of output', async () => {
  const f = fixture(), result = f.run(job, 'mail', f.abort.signal, { resume: 'earlier-session-1' });
  const line = JSON.stringify({ type: 'assistant', parent_tool_use_id: null, session_id: 'earlier-session-1', message: { model: 'm', content: [{ type: 'tool_use', name: 'Bash' }] } });
  const cut = line.indexOf('"type":"assistant"') + 9;
  (f.child.stdout as PassThrough).write(line.slice(0, cut)); await new Promise(resolve => setImmediate(resolve));
  (f.child.stdout as PassThrough).write(line.slice(cut) + '\n'); await new Promise(resolve => setImmediate(resolve));
  f.child.emit('close', 1);
  expect(await result.catch((error: unknown) => error)).not.toBeInstanceOf(HarnessResumeUnavailable);
});
