/** Legacy metadata rendering lives beside the records, never in the remote client. */
import { z } from 'zod';
import { operation, mayAct, OperationError, type Db, type Operations, type Sharing } from '../../core/index.js';
import { secretName } from './input.js';
import { secretStartPermission } from './policy.js';
import type { GrantRequest } from './role.js';
export function installSecretCommands(db: Db, operations: Operations, sharing: () => Sharing) {
  const agent = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/);
  const input = z.discriminatedUnion('command', [
    z.object({ command: z.literal('list'), json: z.boolean().optional() }).strict(),
    z.object({ command: z.literal('may'), agent, name: secretName, json: z.boolean().optional() }).strict(),
    z.object({ command: z.literal('state'), id: z.string().regex(/^q-(?:[0-9a-f]{8}|[0-9a-f-]{36})$/) }).strict(),
  ]);
  operations.register(operation({ name: 'secrets.command', input,
    output: z.object({ stdout: z.string(), stderr: z.string(), code: z.number().int().min(0).max(4) }).strict(),
    may: viewer => mayAct(viewer, { type: 'secret.name' }, sharing(), 'household', 'secrets.command'),
    run(ctx, input) {
      let stdout: string, code = 0;
      if (input.command === 'list') {
        const names = (db.prepare('SELECT id FROM secrets_names ORDER BY id').all() as { id: string }[]).map(row => row.id);
        stdout = input.json ? JSON.stringify(names) + '\n' : names.map(name => name + '\n').join('');
      } else if (input.command === 'may') {
        const may = secretStartPermission(db, input.agent, input.name);
        const why = may === 'denied' ? `the policy never gives ${input.name} out` : may === 'ask'
          ? `${input.name} isn't given to ${input.agent}'s houses at start: the owner allows it (loom secrets policy houses ${input.name} ${input.agent})` : undefined;
        stdout = input.json ? JSON.stringify({ may, ...(why ? { why } : {}) }) + '\n' : `${may}${why ? `: ${why}` : ''}\n`;
        code = may === 'allowed' ? 0 : 1;
      } else {
        const row = db.prepare('SELECT record FROM secrets_requests WHERE id=?').get(input.id) as { record: string } | undefined;
        if (!row) throw new OperationError('not-found', 'There is no such request');
        const request = JSON.parse(row.record) as GrantRequest;
        let state: string = request.state;
        if (request.state === 'allowed') {
          const grants = db.prepare('SELECT record FROM secrets_grants WHERE agent=? AND kind=? AND target=?').all(request.agent, request.kind, request.target) as { record: string }[];
          const grant = grants.map(row => JSON.parse(row.record) as { requestId?: string; expiresAt?: number; movedTo?: string }).find(grant => grant.requestId === request.id && !grant.movedTo);
          state = grant && (grant.expiresAt === undefined || grant.expiresAt > ctx.now) ? 'granted' : 'expired';
        }
        stdout = state + '\n';
      }
      return { stdout, stderr: '', code };
    },
  }));
}
