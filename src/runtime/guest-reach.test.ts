/** A job whose word is anybody else's runs with loom's tools only (policy.ts, loomToolsOnly): what the body
 * side makes of the word the dispatcher hands it. No process is started and nothing live is touched. */
import { expect, it } from 'vitest';
import { loomToolsOnly } from '../policy.js';
import { bodyReach, deniedTools, hasFileTools, hasGuest, refusesJob, withUnknownSender } from './harness-traits.js';
import { harnessCannotRun } from './body-harnesses.js';
import type { WorkerRunPolicy } from './worker.js';

const room = (word: WorkerRunPolicy['word'], deniedTools: WorkerRunPolicy['deniedTools'] = [], people: WorkerRunPolicy['people'] = []): WorkerRunPolicy => ({ deniedTools, people, mail: [], ...(word ? { word } : {}) });

it('states the rule once: only a job on anybody else\'s word is held to loom\'s tools', () => {
  expect(loomToolsOnly('others')).toBe(true);
  expect(loomToolsOnly('owners')).toBe(false);
  expect(loomToolsOnly('own')).toBe(false);
});

it('reads a guest from the job\'s word and from nothing else', () => {
  // A household member without the agent is `person` in the room, and anybody else by the ranking.
  expect(hasGuest(room('others', [], [{ kind: 'person', person: 'lodger', tier: null }]))).toBe(true);
  // An outside account below the top tier used to be a guest by its tier alone; the word decides.
  expect(hasGuest(room('owners', [], [{ kind: 'outside', person: 'x', tier: 1 }]))).toBe(false);
  expect(hasGuest(room('own'))).toBe(false);
  // A loom older than the word says nothing: closed, not open.
  expect(hasGuest(room(undefined, [], [{ kind: 'person', person: 'owner', tier: null }]))).toBe(true);
  expect(hasGuest(undefined)).toBe(false);
  expect(hasGuest(withUnknownSender(room('owners')))).toBe(true);
});

it('keeps the agent\'s denied tools on top: guests-only rows apply on anybody else\'s word, the rest always', () => {
  const rows = [{ pattern: 'WebFetch', guestsOnly: true }, { pattern: 'Bash(rm:*)', guestsOnly: false }];
  expect(deniedTools(room('others', rows))).toEqual(['WebFetch', 'Bash(rm:*)']);
  expect(deniedTools(room('owners', rows))).toEqual(['Bash(rm:*)']);
});

it('gives such a job the reach `loom` whatever the body file says, and no file tools', () => {
  expect(bodyReach('all', room('others'))).toBe('loom');
  expect(bodyReach('all', room('owners'))).toBe('all');
  expect(bodyReach('all', room('own'))).toBe('all');
  expect(bodyReach('loom', room('owners'))).toBe('loom');
  expect(hasFileTools(bodyReach('all', room('others')), room('others'))).toBe(false);
  expect(hasFileTools(bodyReach('all', room('owners')), room('owners'))).toBe(true);
});

it('refuses such a job to a harness that always has a shell, with the machine\'s reach known or not', () => {
  const shell = { needsFullReach: true, honoursDeniedTools: false, reservesEnv: () => false };
  expect(refusesJob(shell, room('others'))).toBe(true);
  expect(refusesJob(shell, room('others'), 'all')).toBe(true);
  expect(refusesJob(shell, room('owners'), 'all')).toBe(false);
  expect(harnessCannotRun('codex', room('others'))).toBe(true);
  expect(harnessCannotRun('agy', room('others'), 'all')).toBe(true);
  expect(harnessCannotRun('claude', room('others'), 'all')).toBe(false);
  expect(harnessCannotRun('codex', room('owners'), 'all')).toBe(false);
});

it('starts Claude Code for such a job with loom\'s tools listed and nothing else allowed, on a machine of full reach', async () => {
  const { claudeBody } = await import('./claude-body.js'), { nativeClaudeFixture } = await import('../../test/fixtures/native-claude.js');
  const job = (word: WorkerRunPolicy['word']) => ({ id: 'j', box: 'b', agent: 'art', conversation: 'cv', model: 'requested-model', account: 'sub', harness: 'claude', brief: '', house: { repository: 'r', file: 'Containerfile', branch: 'next' },
    run: { nestedContainers: false, gpu: false, ports: [], policy: room(word) } });
  const config = () => Buffer.from(JSON.stringify({ mcpServers: { loom: { type: 'http', url: 'http://127.0.0.1:1', headers: { Authorization: 'Bearer local_secret_x' } } } }));
  const f = nativeClaudeFixture();
  const guest = claudeBody({ command: '/private/claude', cwd: '/house', env: f.env, spawn: f.launch, reach: 'all', mcpConfig: config(), mcpTools: ['mcp__loom__loom_query'] })(job('others'), 'mail', f.abort.signal);
  const args: string[] = f.launch.mock.calls[0][1];
  expect(args[args.indexOf('--permission-mode') + 1]).toBe('dontAsk');
  expect(args.slice(args.indexOf('--allowedTools'), args.indexOf('--allowedTools') + 2)).toEqual(['--allowedTools', 'mcp__loom__loom_query']);
  expect(args).not.toContain('bypassPermissions');
  f.finish(f.rows()); await guest.catch(() => {});
  const g = nativeClaudeFixture();
  const owner = claudeBody({ command: '/private/claude', cwd: '/house', env: g.env, spawn: g.launch, reach: 'all', mcpConfig: config(), mcpTools: ['mcp__loom__loom_query'] })(job('owners'), 'mail', g.abort.signal);
  expect(g.launch.mock.calls[0][1][g.launch.mock.calls[0][1].indexOf('--permission-mode') + 1]).toBe('bypassPermissions');
  g.finish(g.rows()); await owner.catch(() => {});
});

it('asks for no startup secret for such a job, and still does for the owners\'', async () => {
  const { bodyProgram } = await import('./body-program.js'), { vi } = await import('vitest');
  const raw = 'body_' + 'a'.repeat(64);
  const run = async (word: WorkerRunPolicy['word']) => {
    const job = { id: 'job', box: 'box', agent: 'art', conversation: 'cv', thread: 'thread', model: 'requested', account: 'sub', harness: 'claude', brief: '', house: { repository: 'r', file: 'Containerfile', branch: 'next' },
      run: { nestedContainers: false, gpu: false, ports: [], policy: room(word) } };
    const input = Buffer.from(JSON.stringify({ job, build: 'image', bootstrap: { origin: 'https://loom.example', job: 'job', token: raw } })), paths: string[] = [];
    const fetcher = vi.fn<typeof fetch>(async url => {
      const path = String(url).split('/').at(-1)!; paths.push(path);
      if (path === 'startup') return Response.json({ aliases: [] });
      const values = { take: { job: 'job', conversation: 'cv', stopRequested: false, items: [{ id: 'mail', seq: 1, source: 'thread', sourceId: null, fromKind: 'person', fromId: 'alice', at: '2026-11-15T00:00:00.000Z', words: 'MAIL', keepUntil: null, verdict: null, refs: [] }] },
        digest: { saved: true, digest: 'digest', revision: 1, item: null }, accept: { saved: true }, confirm: { saved: true }, status: { saved: true, stopRequested: false }, turn: { saved: true, conversation: 'cv', seq: 1 }, message: { saved: true, seq: 2 } };
      return Response.json({ ok: true, value: values[path as keyof typeof values] });
    });
    const code = await bodyProgram({ args: ['config'], read: async () => JSON.stringify({ command: '/native/claude', cwd: '/house', reach: 'all' }), stdin: async () => input, env: {}, signal: new AbortController().signal, fetch: fetcher,
      native: async () => ({ text: 'Answer', model: 'observed', actions: [] }), loadMemory: async () => null, error: () => {} });
    return { code, paths };
  };
  const owners = await run('owners'); expect(owners.code).toBe(0); expect(owners.paths).toContain('startup');
  const guest = await run('others'); expect(guest.code).toBe(0); expect(guest.paths).not.toContain('startup');
});
