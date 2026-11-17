import { expect, it, vi } from 'vitest';
import { bodyHarness, harnessCannotRun, harnessReservesEnv, harnesses } from './body-harnesses.js';
import { deniedTools, hasGuest } from './harness-traits.js';
import type { WorkerAssignment } from './worker.js';
import type { WorkerRunPolicy } from './worker.js';

const policy = (people: WorkerRunPolicy['people'], rules: WorkerRunPolicy['deniedTools'] = [{ pattern: 'Read', guestsOnly: false }, { pattern: 'Bash(*)', guestsOnly: true }, { pattern: 'Read', guestsOnly: true }]): WorkerRunPolicy => ({ people, deniedTools: rules });
it('lists each harness whole: what it can run, what signs it in, and how it is run', () => {
  expect(Object.keys(harnesses).sort()).toEqual(['agy', 'claude', 'codex']);
  for (const harness of Object.values(harnesses)) {
    expect(typeof harness.needsFullReach).toBe('boolean'); expect(typeof harness.honoursDeniedTools).toBe('boolean');
    expect(typeof harness.reservesEnv).toBe('function'); expect(typeof harness.run).toBe('function');
  }
});
it('applies the one refusal in front of every adapter, before anything is launched', async () => {
  const spawn = vi.fn(), signal = new AbortController().signal;
  const job = (harness: string, rules: WorkerRunPolicy['deniedTools'] = []): WorkerAssignment => ({ id: 'job', box: 'box', agent: 'art', conversation: 'cv', model: 'model', account: 'account', harness, brief: '',
    house: { repository: 'r', file: 'f', branch: 'next' }, run: { nestedContainers: false, gpu: false, ports: [], policy: { people: [], deniedTools: rules } } });
  const refused = (name: string, reach: 'loom' | 'all' | undefined, work: WorkerAssignment) =>
    expect(bodyHarness(name, { command: '/native/harness', cwd: '/house', env: {}, spawn, reach })(work, 'mail', signal)).rejects.toThrow(/^Native execution unavailable$/);
  for (const name of ['codex', 'agy']) {
    await refused(name, 'loom', job(name)); await refused(name, undefined, job(name));
    await refused(name, 'all', job(name, [{ pattern: 'Bash(*)', guestsOnly: false }]));
  }
  // A job for another harness is nobody's to run, whatever the adapter.
  for (const name of Object.keys(harnesses)) await refused(name, 'all', job('house-runner'));
  expect(() => bodyHarness('house-runner', { command: '/native/harness', cwd: '/house', env: {} })).toThrow(/^Native execution unavailable$/);
  expect(() => bodyHarness('constructor', { command: '/native/harness', cwd: '/house', env: {} })).toThrow(/^Native execution unavailable$/);
  expect(spawn).not.toHaveBeenCalled();
});
it('reserves for each harness the names that sign it in, and none for a runner it does not list', () => {
  expect(harnessReservesEnv('claude', 'ANTHROPIC_API_KEY', {})).toBe(true); expect(harnessReservesEnv('codex', 'ANTHROPIC_API_KEY', {})).toBe(false);
  expect(harnessReservesEnv('codex', 'OPENAI_API_KEY', {})).toBe(true); expect(harnessReservesEnv('agy', 'GEMINI_API_KEY', {})).toBe(true);
  expect(harnessReservesEnv('claude', 'AWS_PROFILE', {})).toBe(false); expect(harnessReservesEnv('claude', 'AWS_PROFILE', { CLAUDE_CODE_USE_BEDROCK: '1' })).toBe(true);
  expect(harnessReservesEnv('house-runner', 'ANTHROPIC_API_KEY', {})).toBe(false); expect(harnessReservesEnv('toString', 'ANTHROPIC_API_KEY', {})).toBe(false);
});
it('counts as a guest only an outside or unknown sender below the top tier', () => {
  expect(hasGuest(undefined)).toBe(false);
  expect(hasGuest(policy([{ kind: 'person', person: 'owner', tier: null }, { kind: 'outside', person: 'key', tier: 3 }]))).toBe(false);
  for (const tier of [1, 2, null] as const) expect(hasGuest(policy([{ kind: 'outside', person: 'key', tier }]))).toBe(true);
  expect(hasGuest(policy([{ kind: 'unknown', person: null, tier: null }]))).toBe(true);
});
it('applies always-denied tools to every job and guests-only ones when a guest is in the room, each once', () => {
  expect(deniedTools(undefined)).toEqual([]);
  expect(deniedTools(policy([{ kind: 'person', person: 'owner', tier: null }]))).toEqual(['Read']);
  expect(deniedTools(policy([{ kind: 'outside', person: 'key', tier: 1 }]))).toEqual(['Read', 'Bash(*)']);
});
it('knows which harness would refuse a job, with or without knowing the machine', () => {
  const guestOnly = policy([], [{ pattern: 'Bash(*)', guestsOnly: true }]), guest = policy([{ kind: 'unknown', person: null, tier: null }], guestOnly.deniedTools);
  for (const harness of ['codex', 'agy']) {
    expect(harnessCannotRun(harness, guestOnly, 'all')).toBe(false);
    expect(harnessCannotRun(harness, guestOnly, 'loom')).toBe(true);
    // Placement does not know the machine's reach and judges by the room alone.
    expect(harnessCannotRun(harness, guestOnly)).toBe(false);
    expect(harnessCannotRun(harness, guest)).toBe(true);
    expect(harnessCannotRun(harness, guest, 'all')).toBe(true);
  }
  expect(harnessCannotRun('claude', guest, 'loom')).toBe(false);
  // A runner loom has no adapter for is the machine's own business.
  expect(harnessCannotRun('house-runner', guest, 'loom')).toBe(false);
  expect(harnessCannotRun('constructor', guest, 'loom')).toBe(false);
});
