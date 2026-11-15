import {EventEmitter} from 'node:events';
import {PassThrough,Writable} from 'node:stream';
import type {ChildProcessWithoutNullStreams} from 'node:child_process';
import {vi} from 'vitest';
import {claudeBody,type ClaudeSpawn} from '../../src/runtime/claude-body.js';
export function nativeClaudeFixture() {
  let words = '';
  const child = Object.assign(new EventEmitter(), {
    stdin: new Writable({ write(chunk, _encoding, done) { words += chunk.toString(); done(); } }),
    stdout: new PassThrough(), stderr: new PassThrough(),
    kill: vi.fn(() => { child.emit('close', null); return true; }),
  }) as unknown as ChildProcessWithoutNullStreams;
  const launch = vi.fn<ClaudeSpawn>(() => child), abort = new AbortController(), env = { PATH: '/usr/bin', ACCOUNT_PROFILE: '/private/account' };
  const run = claudeBody({ command: '/private/claude', cwd: '/house', env, spawn: launch });
  const session = () => launch.mock.calls[0][1][launch.mock.calls[0][1].indexOf('--session-id') + 1];
  const rows = (extra: Record<string, unknown>[] = []) => [
    { type: 'system', subtype: 'init', model: 'init-model', session_id: session() },
    ...extra.map(row => ({ session_id: session(), ...row })),
    { type: 'assistant', parent_tool_use_id: null, session_id: session(), message: { model: 'observed-model', content: [{ type: 'text', text: 'Answer é' }] } },
    { type: 'result', subtype: 'success', is_error: false, session_id: session(), result: 'Answer é', modelUsage: { 'misleading-model': {} } },
  ];
  const finish = (value: unknown) => { (child.stdout as PassThrough).write(typeof value === 'string' ? value : (value as unknown[]).map(row => JSON.stringify(row)).join('\n')); child.emit('close', 0); };
  return { run, child, launch, abort, env, rows, finish, words: () => words };
}
