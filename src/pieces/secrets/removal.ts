import type { Context } from '../../core/index.js';
import { readSecretPolicy } from './policy.js';
import type { GrantRequest } from './role.js';

/** Metadata half of removal, inside the value operation's transaction. Existing
 * bodies cannot have their copies recalled; subsequent uses must ask again. */
export function removeSecretMetadata(ctx: Context, name: string) {
  const { db } = ctx;
  const grants = db.prepare("SELECT id FROM secrets_grants WHERE kind='secret' AND target=?").all(name) as { id: string }[];
  for (const { id } of grants) {
    db.prepare('DELETE FROM secrets_grants WHERE id=?').run(id);
    ctx.changed('secret.grant', id);
  }
  const requests = db.prepare('SELECT record FROM secrets_requests').all() as { record: string }[];
  for (const row of requests) {
    const request = JSON.parse(row.record) as GrantRequest;
    if (request.kind !== 'secret' || request.target !== name || !['pending', 'allowed'].includes(request.state)) continue;
    request.state = request.state === 'pending' ? 'cancelled' : 'revoked';
    db.prepare('UPDATE secrets_requests SET record=? WHERE id=?').run(JSON.stringify(request), request.id);
    ctx.changed('secret.request', request.id);
  }
  const policy = readSecretPolicy(db);
  const rule = Object.hasOwn(policy.secrets, name) ? policy.secrets[name] : undefined;
  if (rule?.grant === 'auto' || !rule?.grant && policy.default === 'auto') {
    // Keep explicit start mappings and duration, but never revive standing auto
    // permission when the name is added again, even under an auto default.
    const next = { ...rule, grant: 'ask' as const }; delete next.agents;
    policy.secrets[name] = next;
    db.prepare("INSERT INTO secrets_meta VALUES ('policy',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(policy));
    ctx.changed('secret.policy', 'policy');
  }
  db.prepare('DELETE FROM secrets_names WHERE id=?').run(name);
  ctx.changed('secret.name', name);
}
