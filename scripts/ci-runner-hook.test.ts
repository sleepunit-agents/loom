import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const HOOK = resolve(__dirname, 'ci-runner-hook.sh');
let dir: string;

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'runner-hook-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

// A stand-in curl on PATH that answers the merge-queue query with `queue` (or fails, when no queue is given).
function run(event: string, payload: unknown, opts: { repo?: string; queue?: unknown; token?: boolean } = {}) {
  writeFileSync(join(dir, 'event.json'), JSON.stringify(payload));
  writeFileSync(join(dir, 'answer.json'), JSON.stringify(opts.queue ?? null));
  // It also keeps what it was given on stdin, to show the token never reaches its arguments.
  writeFileSync(join(dir, 'curl'), opts.queue === undefined ? '#!/bin/sh\nexit 22\n'
    : `#!/bin/sh\ncat > '${join(dir, 'stdin')}'\necho "$@" > '${join(dir, 'argv')}'\ncat '${join(dir, 'answer.json')}'\n`);
  chmodSync(join(dir, 'curl'), 0o755);
  if (opts.token === false) rmSync(join(dir, 'token'), { force: true });
  else writeFileSync(join(dir, 'token'), 'not-a-token');
  return spawnSync('bash', [HOOK], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      LOOM_RUNNER_HOOK_CURL: join(dir, 'curl'),
      GITHUB_REPOSITORY: opts.repo ?? 'sleepunit-agents/loom',
      GITHUB_EVENT_NAME: event,
      GITHUB_EVENT_PATH: join(dir, 'event.json'),
      LOOM_RUNNER_QUEUE_TOKEN_FILE: join(dir, 'token'),
    },
  });
}

const pr = (head: string | null, user = 'art-e-fish') => ({
  pull_request: { head: { repo: head === null ? null : { full_name: head } }, user: { login: user } },
});
const SHA = 'a'.repeat(40);
const group = (base = 'refs/heads/main', head_sha = SHA) => ({ merge_group: { base_ref: base, head_sha } });
// Queue entries in order; the last one's head commit is SHA unless said otherwise.
const queue = (entries: Array<{ number: number; isCrossRepository: boolean }>, totalCount = entries.length, last = SHA) => ({
  data: { repository: { mergeQueue: { entries: { totalCount, nodes: entries.map((pullRequest, i) => ({
    headCommit: { oid: i === entries.length - 1 ? last : String(i).repeat(40) }, pullRequest,
  })) } } } },
});

describe('ci-runner-hook.sh', () => {
  it('lets a push run', () => {
    expect(run('push', {}).status).toBe(0);
  });

  it("lets this repository's own pull request run", () => {
    expect(run('pull_request', pr('sleepunit-agents/loom')).status).toBe(0);
  });

  it.each([
    ['a fork', pr('someone/loom')],
    ['a deleted fork', pr(null)],
    ['Dependabot', pr('sleepunit-agents/loom', 'dependabot[bot]')],
  ])("refuses a pull request from %s", (_, payload) => {
    const r = run('pull_request', payload);
    expect(r.status).not.toBe(0);
    expect(r.stdout).toContain('refuses');
  });

  it('refuses another repository and other events', () => {
    expect(run('push', {}, { repo: 'someone/loom' }).status).not.toBe(0);
    expect(run('pull_request_target', pr('sleepunit-agents/loom')).status).not.toBe(0);
    expect(run('workflow_run', {}).status).not.toBe(0);
  });

  it('lets a merge-queue group run while only our own pull requests are queued', () => {
    expect(run('merge_group', group(), { queue: queue([{ number: 1, isCrossRepository: false }]) }).status).toBe(0);
  });

  it("refuses a merge-queue group that holds a fork's pull request", () => {
    const r = run('merge_group', group(), { queue: queue([{ number: 1, isCrossRepository: true }, { number: 2, isCrossRepository: false }]) });
    expect(r.status).not.toBe(0);
    expect(r.stdout).toContain('#1');
  });

  it("lets a group run with a fork's pull request queued behind it, which isn't in its code", () => {
    const behind = queue([{ number: 1, isCrossRepository: false }, { number: 2, isCrossRepository: true }]);
    behind.data.repository.mergeQueue.entries.nodes[0].headCommit.oid = SHA;
    behind.data.repository.mergeQueue.entries.nodes[1].headCommit.oid = 'c'.repeat(40);
    expect(run('merge_group', group(), { queue: behind }).status).toBe(0);
  });

  it('sends the token on stdin, not in arguments', () => {
    expect(run('merge_group', group(), { queue: queue([{ number: 1, isCrossRepository: false }]) }).status).toBe(0);
    expect(readFileSync(join(dir, 'stdin'), 'utf8')).toContain('not-a-token');
    expect(readFileSync(join(dir, 'argv'), 'utf8')).not.toContain('not-a-token');
  });

  it('refuses a merge-queue group no longer queued, or not on main', () => {
    const ours = queue([{ number: 1, isCrossRepository: false }]);
    expect(run('merge_group', group(), { queue: queue([{ number: 1, isCrossRepository: false }], 1, 'b'.repeat(40)) }).status).not.toBe(0);
    expect(run('merge_group', group('refs/heads/hat-v1'), { queue: ours }).status).not.toBe(0);
    expect(run('merge_group', group('refs/heads/main', ''), { queue: ours }).status).not.toBe(0);
  });

  it("refuses a merge-queue group when it can't read the whole queue", () => {
    expect(run('merge_group', group()).status).not.toBe(0); // curl fails
    expect(run('merge_group', group(), { queue: { errors: [{ message: 'nope' }] } }).status).not.toBe(0);
    expect(run('merge_group', group(), { queue: queue([{ number: 1, isCrossRepository: false }], 101) }).status).not.toBe(0);
    expect(run('merge_group', group(), { queue: queue([]), token: false }).status).not.toBe(0);
    expect(run('merge_group', group(), { queue: { data: { repository: { mergeQueue: { entries: { totalCount: 0, nodes: null } } } } } }).status).not.toBe(0);
    const nullPr = queue([{ number: 1, isCrossRepository: false }]);
    (nullPr.data.repository.mergeQueue.entries.nodes[0] as { pullRequest: unknown }).pullRequest = null;
    expect(run('merge_group', group(), { queue: nullPr }).status).not.toBe(0);
  });

  it('refuses when the event payload is unreadable', () => {
    writeFileSync(join(dir, 'event.json'), 'not json');
    const r = spawnSync('bash', [HOOK], { encoding: 'utf8', env: { PATH: process.env.PATH, GITHUB_REPOSITORY: 'sleepunit-agents/loom', GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: join(dir, 'event.json') } });
    expect(r.status).not.toBe(0);
  });
});
