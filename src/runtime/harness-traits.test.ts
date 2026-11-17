import { expect, it } from 'vitest';
import { bodyHarnesses } from './body-harnesses.js';
import { deniedTools, harnessCannotRun, harnessTraits, hasGuest } from './harness-traits.js';
import type { WorkerRunPolicy } from './worker.js';

const policy = (people: WorkerRunPolicy['people'], rules: WorkerRunPolicy['deniedTools'] = [{ pattern: 'Read', guestsOnly: false }, { pattern: 'Bash(*)', guestsOnly: true }, { pattern: 'Read', guestsOnly: true }]): WorkerRunPolicy => ({ people, deniedTools: rules });
it('describes exactly the harnesses a body can run on', () => {
  expect(Object.keys(harnessTraits).sort()).toEqual(Object.keys(bodyHarnesses).sort());
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
