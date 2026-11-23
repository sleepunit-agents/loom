import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exampleHome } from '../dist/example-home.js';
import { FakeClock } from '../dist/core/clock.js';
import { startSharedHome } from '../dist/shared-startup.js';
import { httpWorkerControl } from '../dist/runtime/worker-http.js';
import { REPORT_MS, SILENCE_MS } from '../dist/runtime/silence.js';

async function verifyOutcome(ending) {
  const dir = await mkdtemp(join(tmpdir(), 'loom-job-outcome-'));
  const home = join(dir, 'home');
  let app, child;
  try {
    const example = await exampleHome(home);
    assert.equal(example.fictional, true);
    const { box, job, conversation } = example.runtime;
    const clock = new FakeClock(Date.parse(example.createdAt));
    const open = () => startSharedHome({ home, clock, port: 0, stdout() {} });
    app = await open();
    const issue = key => app.writes.run(() => app.services.signin.issue(key)).value.token;
    const owner = issue({ kind: 'owner', member: 'alex', label: 'Example reader' });
    const runner = issue({ kind: 'runner', box, label: 'Example worker' });
    const signal = AbortSignal.timeout(30_000);
    const worker = httpWorkerControl({ url: app.url, token: runner, slots: 12, signal });
    const state = () => app.services.comms.db.$client.prepare('SELECT state FROM jobs WHERE id=?').get(job.id).state;
    const post = async (path, payload) => {
      const response = await fetch(app.url + path, { method: 'POST', signal, redirect: 'error',
        headers: { authorization: 'Bearer ' + owner, 'content-type': 'application/json' },
        body: JSON.stringify(payload) });
      assert.equal(response.status, 200);
      return response.json();
    };

    assert.equal(state(), 'queued');
    let assignment;
    do {
      assignment = await worker.next();
      assert.ok(assignment, 'The example worker must receive the original job');
    } while (assignment.id !== job.id);
    assert.equal(assignment.box, box);
    assert.equal(state(), 'starting');
    // Only the process exit is synthetic. The coordinator sees normal worker calls or silence.
    child = spawn(process.execPath, ['-e', 'process.stdin.once("data", b => process.exit(Number(b)))'],
      { env: {}, stdio: ['pipe', 'ignore', 'ignore'] });
    await once(child, 'spawn');
    const exited = once(child, 'exit');
    await worker.started(job.id, 'example-build');
    assert.equal(state(), 'running');
    if (ending === 'lost') {
      child.kill('SIGKILL');
      assert.equal((await exited)[1], 'SIGKILL');
      clock.advance(SILENCE_MS - 1);
      assert.equal(state(), 'running');
      clock.advance(2 * REPORT_MS + 1001);
    } else if (ending === 'stopped') {
      const result = await post('/api/runtime/jobStop', {
        id: crypto.randomUUID(), input: { job: job.id, reason: 'write-off' } });
      assert.equal(result.ok, true);
      assert.equal(await worker.heartbeat(job.id, 'running'), false);
      child.kill();
      await exited;
    } else {
      const code = ending === 'done' ? 0 : 23;
      child.stdin.end(String(code));
      const [actual] = await exited;
      assert.equal(actual, code);
      await worker.finish(job.id, actual, '', 'body');
    }
    assert.equal(state(), ending);
    await app.close();
    app = await open();
    const result = await post('/graphql', { query: '{jobHistory(agent:"moss",first:40){id state conversation}}' });
    assert.equal(result.errors, undefined);
    const row = result.data.jobHistory.find(item => item.id === job.id);
    assert.equal(row?.state, ending);
    assert.equal(row.conversation, conversation);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    try { await app?.close(); } finally { await rm(dir, { recursive: true, force: true }); }
  }
}

export async function jobOutcomeEvidence() {
  for (const ending of ['done', 'failed', 'stopped', 'lost']) await verifyOutcome(ending);
  return { ok: true, reason: 'Four queued jobs were claimed and ran. Member history preserved the success, failure, owner stop and silence timeout after restart.' };
}
