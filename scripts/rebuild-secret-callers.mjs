import assert from 'node:assert/strict';
import { members } from '../dist/core/data/schema.js';

// The installed holder walkthrough has already created requests, rules, grants and uses.
export async function secretCallers({ app, clock, name, owner, agentToken, machineToken, ownerToken }) {
  const { signin, programSetup } = app.services;
  const db = app.services.comms.db;
  const fields = [
    ['secrets', 'secrets', 'name'],
    ['secretRequests', 'secret_requests', 'secret'],
    ['secretGrants', 'secret_grants', 'secret'],
    ['secretRules', 'secret_rules', 'secret'],
    ['secretRuleAgents', 'secret_rule_agents', 'secret'],
    ['secretUses', 'secret_uses', 'secret'],
    ['secretChanges', 'secret_changes', 'secret'],
  ];
  const visible = {}, empty = {};
  const query = '{' + fields.map(([field, table, key]) => {
    const rows = db.$client.prepare('SELECT ' + key + ' FROM ' + table + ' WHERE ' + key + '=?').all(name);
    assert.ok(rows.length > 0, 'Missing internal fixture records for ' + field);
    visible[field] = rows;
    empty[field] = [];
    return field + '(where:{' + key + ':{eq:' + JSON.stringify(name) + '}}){' + key + '}';
  }).join(' ') + '}';
  async function read(token) {
    const response = await fetch(new URL('/graphql', app.url), {
      method: 'POST',
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: JSON.stringify({ query }),
    });
    return { status: response.status, body: await response.json() };
  }
  const credentials = [];
  function issue(create) {
    const credential = app.writes.run(create).value;
    credentials.push(credential.fingerprint);
    return credential.token;
  }
  const member = 'garden-reader';
  const label = 'Garden fixture metadata';
  try {
    app.writes.run(() => db.insert(members).values({id: member, role: 'member', joinedAt: new Date(clock.now()).toISOString()}).run());
    const memberToken = issue(() => signin.issue({kind: 'owner', member, label}));
    const records = fields.map(([field]) => field);
    for (const [person, expected] of [[owner, visible], [member, empty]]) {
      const program = issue(() => programSetup.issue({member: person, label: label + ' program ' + person, records, operations: []}));
      assert.deepEqual(await read(program), {status: 200, body: {data: expected}});
    }
    for (const [token, expected] of [[ownerToken, visible], [memberToken, empty], [agentToken, empty]]) {
      assert.deepEqual(await read(token), {status: 200, body: {data: expected}});
    }
    const machine = await read(machineToken);
    assert.equal(machine.status, 403);
    assert.equal(machine.body.data, undefined);
    return {ok: true, reason: 'Seven metadata collections had internal records. The owner and their scoped program saw them. The ordinary member, their equally scoped program and the working agent saw empty collections. The enrolled worker had no GraphQL access.'};
  } finally {
    app.writes.run(() => { for (const fingerprint of credentials) signin.revoke(fingerprint); });
  }
}
