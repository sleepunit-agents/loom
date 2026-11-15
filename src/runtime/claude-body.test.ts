import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { expect, it, vi } from 'vitest';
import { claudeBody } from './claude-body.js';
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
  await expect(result).rejects.toThrow('Native Claude execution unavailable');
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
  await expect(f.run(changed, 'mail', f.abort.signal)).rejects.toThrow(); expect(f.launch).not.toHaveBeenCalled();
});

it('does not classify authenticated household people as guests from a missing outside tier', async () => {
  const f = fixture(), configured = structuredClone(job); configured.run!.policy!.people = [{kind:'person',person:'household-member',tier:null}];
  const result = f.run(configured,'mail',f.abort.signal); expect(f.launch.mock.calls[0][1].slice(-2)).toEqual(['--disallowedTools','Read']); f.finish(f.rows()); await result;
});

it('handles actual foreground child pipes with a fake provider, without native diagnostics escaping', async () => {
  const run = claudeBody({command:'/configured/fake-provider',cwd:process.cwd(),env:{},
    spawn: (_command,args,options) => spawn(process.execPath,['-e',[
      "const args=process.argv.slice(1),session=args[args.indexOf('--session-id')+1];",
      "let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',part=>input+=part);",
      "process.stdin.on('end',()=>{if(input!=='PRIVATE MAIL')process.exit(9);",
      "process.stderr.write('PRIVATE DIAGNOSTIC');",
      "process.stdout.write(JSON.stringify({type:'assistant',session_id:session,parent_tool_use_id:null,message:{model:'observed-fake',content:[{type:'text',text:'Answer'}]}})+'\\n');",
      "process.stdout.write(JSON.stringify({type:'result',session_id:session,subtype:'success',is_error:false,result:'Answer'})+'\\n');});",
    ].join(''),'--',...args],options),
  });
  expect(await run(job,'PRIVATE MAIL',new AbortController().signal)).toEqual({text:'Answer',model:'observed-fake',actions:[]});
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
 await expect(pending).rejects.toThrow('Native Claude execution unavailable');
 expect(lateOut.every(byte=>byte===0)).toBe(true);expect(lateError.every(byte=>byte===0)).toBe(true);
});
