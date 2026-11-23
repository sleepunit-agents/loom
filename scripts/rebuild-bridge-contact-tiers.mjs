import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readAgentBodyPolicy } from '../dist/shared-agent-body-policy.js';
import { BridgeIncoming, UNKNOWN_SENDER } from '../dist/pieces/bridges/incoming.js';
import { bridgeConnections, secrets } from '../dist/core/data/schema.js';
import { eq } from 'drizzle-orm';

export async function bridgeContactTiers({ app, clock }) {
  const db = app.services.comms.db;
  const write = (action) => app.writes.run(action).value;
  const now = () => new Date(clock.now()).toISOString();
  const credentials = [];
  function issue(input) {
    const receipt = write(() => app.services.signin.issue(input));
    credentials.push(receipt.fingerprint);
    return receipt.token;
  }
  async function command(path, input, token) {
    const response = await fetch(new URL('/api/' + path, app.url), {
      method: 'POST',
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: JSON.stringify({ id: randomUUID(), input }),
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.ok, true, result.message);
    return result.value;
  }
  const outside = { platform: 'slack', workspace: 'TTIER', user: 'UGARDENER' };
  const personTier = (agent) =>
    readAgentBodyPolicy(db, agent).people.find(
      (person) =>
        person.platform === outside.platform &&
        person.workspace === outside.workspace &&
        person.user === outside.user,
    )?.tier;
  try {
    const fern = issue({ kind: 'agent', agent: 'fern', label: 'Fixture contact tier' });
    const owner = issue({ kind: 'owner', member: 'alex', label: 'Fixture contact tier owner' });
    for (const tier of [2, 3]) {
      const before = personTier('fern');
      const card = await command(
        'household/propose',
        {
          change: 'colleague',
          input: { agent: 'fern', ...outside, tier },
          why: 'Set the fictional garden contact’s interaction tier.',
        },
        fern,
      );
      assert.equal(card.state, 'pending');
      assert.equal(personTier('fern'), before);
      await command('approvals/answer', { id: card.id, answer: 'allow' }, owner);
      assert.equal(personTier('fern'), tier);
      assert.equal(personTier('moss'), undefined);
    }
    // Every connection is disabled before commit, so the daemon never contacts a provider.
    write(() => {
      const tokenSecret = 'walkthrough-contact-tier-placeholder';
      db.insert(secrets)
        .values({ name: tokenSecret, description: 'Fixture', changedBy: 'alex', changedAt: now() })
        .run();
      const ingress = new BridgeIncoming(db, now);
      for (const agent of ['fern', 'moss']) {
        const connection = 'walkthrough-contact-tier-' + agent;
        db.insert(bridgeConnections)
          .values({
            id: connection,
            agent,
            platform: outside.platform,
            workspace: outside.workspace,
            botUser: 'bot-' + agent,
            tokenSecret,
            enabled: true,
            state: 'connected',
            stateAt: now(),
          })
          .run();
        const received = ingress.receive({
          id: 'message-' + agent,
          connection,
          channel: 'DTEST',
          isDm: true,
          user: outside.user,
          text: 'Garden update',
          postedAt: now(),
          mentions: [],
        });
        if (agent === 'fern') {
          assert.equal(received.state, 'delivered');
          assert.equal(received.member, null);
          assert.ok(received.conversation);
        } else {
          assert.equal(received.state, 'dropped');
          assert.equal(received.reason, UNKNOWN_SENDER);
          assert.equal(received.conversation, null);
        }
        db.update(bridgeConnections)
          .set({ enabled: false })
          .where(eq(bridgeConnections.id, connection))
          .run();
      }
    });
    return {
      ok: true,
      reason:
        'The owner approved a contact at tier 2 and changed it to tier 3. The contact reached Fern as an outside sender. Moss still dropped the same account.',
    };
  } finally {
    for (const fingerprint of credentials) write(() => app.services.signin.revoke(fingerprint));
  }
}
