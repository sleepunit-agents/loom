import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
  writeFileSync(join(dir, 'curl'), opts.queue === undefined ? '#!/bin/sh\nexit 22\n' : `#!/bin/sh\ncat '${join(dir, 'answer.json')}'\n`);
  chmodSync(join(dir, 'curl'), 0o755);
  if (opts.token === false) rmSync(join(dir, 'token'), { force: true });
  else writeFileSync(join(dir, 'token'), 'not-a-token');
  return spawnSync('bash', [HOOK], {
    encoding: 'utf8',
    env: {
      PATH: `${dir}:${process.env.PATH}`,
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
const queue = (entries: Array<{ number: number; isCrossRepository: boolean }>, totalCount = entries.length) => ({
  data: { repository: { mergeQueue: { entries: { totalCount, nodes: entries.map((pullRequest) => ({ pullRequest })) } } } },
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
    expect(run('merge_group', {}, { queue: queue([{ number: 1, isCrossRepository: false }]) }).status).toBe(0);
  });

  it("refuses a merge-queue group while a fork's pull request is queued", () => {
    const r = run('merge_group', {}, { queue: queue([{ number: 1, isCrossRepository: false }, { number: 2, isCrossRepository: true }]) });
    expect(r.status).not.toBe(0);
    expect(r.stdout).toContain('#2');
  });

  it("refuses a merge-queue group when it can't read the whole queue", () => {
    expect(run('merge_group', {}).status).not.toBe(0); // curl fails
    expect(run('merge_group', {}, { queue: { errors: [{ message: 'nope' }] } }).status).not.toBe(0);
    expect(run('merge_group', {}, { queue: queue([{ number: 1, isCrossRepository: false }], 101) }).status).not.toBe(0);
    expect(run('merge_group', {}, { queue: queue([]), token: false }).status).not.toBe(0);
  });
});
