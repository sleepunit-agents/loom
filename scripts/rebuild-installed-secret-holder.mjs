import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { channel } from 'node:diagnostics_channel';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import Database from 'better-sqlite3';
import { Decrypter } from 'age-encryption';
import { FakeClock } from '../dist/core/clock.js';
import { agents, boxes, jobs } from '../dist/core/data/schema.js';
import { httpWorkerControl } from '../dist/runtime/worker-http.js';
import { privateSecretClient } from '../dist/pieces/secrets/private-client.js';
import { startSharedHome } from '../dist/shared-startup.js';

async function verifyGrant(app, clock, owner, name, value) {
  const db = app.services.comms.db,
    agent = 'assistant',
    box = 'fixture-box',
    job = 'fixture-job';
  const now = new Date(clock.now()).toISOString(),
    id = randomUUID();
  const issue = (input) => app.writes.run(() => app.services.signin.issue(input)).value;
  app.writes.run(() => {
    db.insert(boxes)
      .values({
        id: box,
        name: 'Garden fixture',
        owner,
        sameMachineAsLoom: false,
        hostsAny: false,
        reportOnly: false,
        alwaysOn: false,
        enrolledAt: now,
      })
      .run();
    db.insert(agents)
      .values({
        id: 'fern',
        about: 'Garden fixture',
        markBg: '#000000',
        markFg: '#ffffff',
        faceShape: 'pebble',
        faceEyes: 'dot',
      })
      .run();
    for (const [jobId, jobAgent] of [
      [job, agent],
      ['watering', agent],
      ['sowing', 'fern'],
    ]) {
      db.insert(jobs)
        .values({
          id: jobId,
          box,
          agent: jobAgent,
          state: 'starting',
          title: 'Garden check',
          brief: '',
          model: 'fixture',
          startedByKind: 'agent',
          startedBy: agent,
          houseRepository: '',
          houseFile: '',
          houseBranch: 'next',
          queuedAt: now,
        })
        .run();
    }
  });
  const runner = issue({ kind: 'runner', box, label: 'Garden fixture worker' });
  const member = issue({ kind: 'owner', member: owner, label: 'Garden fixture owner' });
  const controller = new AbortController();
  const control = httpWorkerControl({ url: app.url, token: runner.token, signal: controller.signal });
  async function command(path, input, token) {
    const response = await fetch(new URL('/api/' + path, app.url), {
      method: 'POST',
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: JSON.stringify({ id: randomUUID(), input }),
    });
    assert.equal(response.status, 200);
    const receipt = await response.json();
    assert.equal(receipt.ok, true);
    return receipt.value;
  }
  let body, reader;
  try {
    body = await control.enrollBody(job, controller.signal);
    await control.started(job, 'fixture');
    const token = body.token.toString('ascii');
    const agentRequestId = randomUUID();
    const request = {
      id,
      secret: name,
      scope: 'job',
      minutes: 1,
      why: 'Inspect the fictional garden schedule.',
    };
    const requests = app.services.secrets.requests;
    assert.deepEqual(await command('secrets/request', request, token), { id, state: 'pending' });
    const pendingResponse = await fetch(new URL('/graphql', app.url), {
      method: 'POST',
      headers: { authorization: 'Bearer ' + member.token, 'content-type': 'application/json' },
      body: JSON.stringify({ query: '{ secretRequests { id why minutes state } }' }),
    });
    assert.equal(pendingResponse.status, 200);
    const pending = await pendingResponse.json();
    assert.deepEqual(
      pending.data?.secretRequests.find((row) => row.id === id),
      { id, why: request.why, minutes: 1, state: 'pending' },
    );
    assert.equal(requests.grantFor(name, agent, job, id), undefined);
    reader = privateSecretClient({ url: app.url, token, signal: controller.signal, clock });
    await assert.rejects(reader.granted(name, id), /Private secret input unavailable/);
    await command('secrets/command', { action: 'answer', id, allow: true, always: true }, member.token);
    const grant = requests.grantFor(name, agent, job, id);
    assert.equal(grant.agent, agent);
    assert.equal(grant.job, job);
    assert.equal(grant.grantedBy, owner);
    assert.equal(requests.grantFor(name, agent, undefined, id), undefined);
    const uses = () =>
      db.$client
        .prepare('SELECT secret,agent,job,at,state FROM secret_uses WHERE secret=? ORDER BY rowid')
        .all(name);
    assert.equal(uses().length, 0);
    async function withJobReader(jobId, work) {
      const other = await control.enrollBody(jobId, controller.signal);
      const client = privateSecretClient({
        url: app.url,
        token: other.token.toString('ascii'),
        signal: controller.signal,
        clock,
      });
      try {
        await control.started(jobId, 'fixture');
        await work(client);
      } finally {
        client.close();
        other.erase();
      }
    }
    const refused = (requestId) => (client) =>
      assert.rejects(client.granted(name, requestId), /Private secret input unavailable/);
    const expectedUses = [];
    async function checkDelivery(client, jobId, requestId) {
      clock.advance(1_000);
      const bytes = await client.granted(name, requestId);
      try {
        assert.ok(bytes.equals(Buffer.from(value)), 'Granted bytes differed from the fictional value');
      } finally {
        bytes.fill(0);
      }
      expectedUses.push({
        secret: name,
        agent,
        job: jobId,
        at: new Date(clock.now()).toISOString(),
        state: 'released',
      });
      assert.deepEqual(uses(), expectedUses);
    }
    await withJobReader('watering', async (watering) => {
      await refused(id)(watering);
      assert.deepEqual(
        await command('secrets/request', { ...request, id: agentRequestId, scope: 'agent' }, token),
        { id: agentRequestId, state: 'allowed' },
      );
      const agentGrant = requests.grantFor(name, agent, undefined, agentRequestId);
      assert.equal(agentGrant?.grantedBy, 'rule');
      assert.equal(agentGrant.agent, agent);
      assert.equal(agentGrant.job, null);
      await withJobReader('sowing', refused(agentRequestId));
      await checkDelivery(reader, job, id);
      await checkDelivery(watering, 'watering', agentRequestId);
    });
    const unused = randomUUID();
    assert.deepEqual(await command('secrets/request', { ...request, id: unused }, token), {
      id: unused,
      state: 'allowed',
    });
    assert.ok(requests.grantFor(name, agent, job, unused));
    clock.advance(57_999);
    assert.equal(requests.grantFor(name, agent, job, id)?.id, grant.id);
    assert.ok(requests.grantFor(name, agent, undefined, agentRequestId));
    clock.advance(1);
    assert.equal(requests.grantFor(name, agent, undefined, agentRequestId), undefined);
    assert.equal(requests.grantFor(name, agent, job, id), undefined);
    clock.advance(2_000);
    await assert.rejects(reader.granted(name, unused), /Private secret input unavailable/);
    assert.deepEqual(uses(), expectedUses);
  } finally {
    reader?.close();
    body?.erase();
    controller.abort();
    app.writes.run(() => {
      app.services.signin.revoke(runner.fingerprint);
      app.services.signin.revoke(member.fingerprint);
    });
  }
}

export async function installedSecretHolder() {
  const parent = await mkdtemp(join(tmpdir(), 'loom-holder-walkthrough-'));
  const home = join(parent, 'home'),
    directory = join(home, 'secret-holder');
  const value = randomBytes(32).toString('hex'),
    name = 'GARDEN_FIXTURE';
  const children = [],
    clock = new FakeClock(Date.now());
  const events = channel('child_process');
  const observe = ({ process: child }) => children.push(child);
  let app;
  async function start() {
    events.subscribe(observe);
    try {
      app = await startSharedHome({ home, clock, host: '127.0.0.1', port: 0, stdout() {} });
    } finally {
      events.unsubscribe(observe);
    }
    assert.equal(new URL(app.url).hostname, '127.0.0.1');
    const holder = children.find(
      (child) =>
        child.spawnargs?.includes(directory) &&
        child.spawnargs.some((arg) => basename(arg) === 'shared-holder-program.js') &&
        child.connected,
    );
    assert.ok(
      holder?.pid && holder.pid !== process.pid,
      'Expected a separate holder process for the fixture home',
    );
    return holder;
  }
  function ciphertext() {
    const db = new Database(join(directory, 'holder.db'), { readonly: true, fileMustExist: true });
    try {
      const bytes = db.prepare('SELECT ciphertext FROM holder_values WHERE name=?').pluck().get(name);
      assert.ok(Buffer.isBuffer(bytes) && bytes.subarray(0, 21).toString() === 'age-encryption.org/v1');
      assert.ok(!bytes.includes(value), 'Fixture value appeared in holder ciphertext');
      return bytes;
    } finally {
      db.close();
    }
  }
  try {
    const first = await start();
    const db = app.services.comms.db.$client;
    const owner = db.prepare("SELECT id FROM members WHERE role='owner'").pluck().get();
    await app.services.secrets.values.set({
      member: owner,
      id: randomUUID(),
      name,
      description: 'Fictional garden access',
      value,
      mode: 'add',
    });
    const before = ciphertext();
    const decrypt = new Decrypter();
    const fixtureKey = await readFile(join(directory, 'identity'));
    try {
      decrypt.addIdentity(fixtureKey.toString('utf8').trim());
    } finally {
      fixtureKey.fill(0);
    }
    const recovered = await decrypt.decrypt(before);
    try {
      assert.ok(Buffer.from(value).equals(recovered), 'Stored age record differed from the fixture');
    } finally {
      recovered.fill(0);
    }
    assert.equal(
      db.prepare("SELECT count(*) FROM sqlite_schema WHERE name='holder_values'").pluck().get(),
      0,
    );
    for (const file of (await readdir(home)).filter((file) => file.startsWith('loom.db'))) {
      assert.ok(
        !(await readFile(join(home, file))).includes(value),
        'Fixture value appeared in household database',
      );
    }
    await app.close();
    app = undefined;
    assert.equal(first.exitCode, 0);
    const second = await start();
    assert.notEqual(second, first);
    assert.ok(ciphertext().equals(before), 'Encrypted record changed when the home reopened');
    await verifyGrant(app, clock, owner, name, value);
    await app.services.secrets.values.remove({ member: owner, id: randomUUID(), name });
    const holderDb = new Database(join(directory, 'holder.db'), { readonly: true, fileMustExist: true });
    try {
      assert.equal(holderDb.prepare('SELECT count(*) FROM holder_values WHERE name=?').pluck().get(name), 0);
    } finally {
      holderDb.close();
    }
    return {
      ok: true,
      reason:
        'A separate holder process stored an age-encrypted fixture value in its own database. The household database contained no fixture value. A new holder served the original bytes to two jobs of the approved agent. Both releases recorded the agent, job and time. The grant expired at one minute and the owner removed the stored value.',
    };
  } finally {
    try {
      await app?.close();
    } finally {
      await rm(parent, { force: true, recursive: true });
    }
  }
}
