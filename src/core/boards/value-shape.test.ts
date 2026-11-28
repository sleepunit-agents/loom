/** ./value-shape.ts: what a typed name is refused for, the one test the page and `boards.act` both use. */
import { expect, it } from 'vitest';
import { looksLikeCredential } from '../../runtime/fixed-program.js';
import { looksLikeSecretValue, loomBearer } from './value-shape.js';

it('refuses loom\'s own bearer, the credentials loom\'s output check knows, and a long run of mixed letters and digits', () => {
  const bearer = 'loom_' + 'aZ9_-'.repeat(8) + 'abc';
  expect(loomBearer.test(bearer)).toBe(true);
  for (const name of [
    bearer, 'ghp_' + 'A1b2'.repeat(6), 'gho_' + 'x'.repeat(20), 'github_pat_' + 'Ab3'.repeat(8), 'xoxb-' + '12ab'.repeat(4),
    'sk-' + 'q'.repeat(20), 'sk-ant-api03-' + 'k'.repeat(24), 'AGE-SECRET-KEY-' + '1Q'.repeat(12), 'body_' + 'af'.repeat(16),
    // after a separator, as the start of a word
    'deploy.ghp_' + 'A1b2'.repeat(6), 'ci/' + bearer, 'laptop:sk-' + 'q'.repeat(20),
    // no known prefix: 32 or more, no separator, letters and digits mixed
    'Zx9q8W7e6R5t4Y3u2I1o0P9a8S7d6F5g', 'a'.repeat(31) + '1', 'prefix.' + 'f3'.repeat(20),
  ]) expect(looksLikeSecretValue(name), name).toBe(true);
});

it('takes ordinary names, including ones the output check would find a credential inside', () => {
  for (const name of ['PUMP_TOKEN', 'github-deploy-key', 'ci:runner', 'pump-laptop', 'shed.pi', 'art@one', 'ci/runner:2', 'MAIL_KEY', 'x'.repeat(120), '1'.repeat(64),
    'a'.repeat(29) + '12', 'synthetic-private-value-7Q', 'pump-station-north-2026-11-27-backup'])
    expect(looksLikeSecretValue(name), name).toBe(false);
  // The list is written for text, so it finds `sk-` and twenty more inside a word: here that is a name.
  for (const name of ['task-runner-pump-station-north', 'disk-backup-controller-north']) {
    expect(looksLikeCredential(name), name).toBe(true);
    expect(looksLikeSecretValue(name), name).toBe(false);
  }
});

it('lets through what docs/accepted-tradeoffs.md says it lets through: a short or broken-up value of no known prefix', () => {
  for (const name of ['hunter2', 'Tr0ub4dor-and-3', 'aB3dE6gH9jK2mN5pQ8-sT1vW4yZ7bC0eF3h']) expect(looksLikeSecretValue(name), name).toBe(false);
});
