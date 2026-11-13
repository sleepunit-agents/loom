import { z } from 'zod';
import { operation, OperationError, mayAct, type Db, type Operations, type Sharing } from '../../core/index.js';
import { boxRecord, type RuntimeRecords } from './records.js';
import { runtimeStore } from './store.js';

type Box = RuntimeRecords['box'];
const ref = z.string().min(1).max(200);
/** Exact live ids win over names. A shared name needs an id, never an arbitrary winner. */
export function resolveBox(store: ReturnType<typeof runtimeStore>, reference: string): Box {
  const exact = store.read('box', reference);
  if (exact && exact.revokedAt === undefined) return boxRecord.parse(withoutTimestamp(exact));
  const matches = store.ids('box').map(id => store.read('box', id)!)
    .filter(b => b.revokedAt === undefined && b.name === reference);
  if (!matches.length) throw new OperationError('not-found', 'No live box matches that reference');
  if (matches.length > 1) throw new OperationError('conflict', 'Several boxes have that name; use an id');
  return boxRecord.parse(withoutTimestamp(matches[0]));
}
function withoutTimestamp<T extends { changedAt: number }>(record: T): Omit<T, 'changedAt'> {
  const { changedAt: _timestamp, ...value } = record;
  return value;
}
/** Report-only implies watching without overwriting the owner's explicit always-on setting. */
export const boxAlwaysOn = (box: Box): boolean => box.local || box.reportOnly || box.alwaysOn;
/** Placement eligibility is domain state, not caller authorization (which stays in policy.ts). */
export function canHost(box: Box, agent: string, sharing: Sharing): boolean {
  const named = Object.entries(sharing.members).filter(([, m]) => !m.owner && m.agents.includes(agent));
  const owners = named.length ? named : Object.entries(sharing.members).filter(([, m]) => m.owner);
  return box.revokedAt === undefined && !box.reportOnly
    && (box.mayHost === '*' || box.mayHost.includes(agent))
    && (owners.some(([id]) => id === box.owner) || box.lentTo.includes(agent));
}

/** Existing enrolled boxes only; credentials and runner setup belong to the central enrollment path. */
export function installBoxOperations(db: Db, operations: Operations, sharing: () => Sharing) {
  const store = runtimeStore(db);
  operations.register(operation({
    name: 'runtime.configureBox', write: true,
    input: z.object({ box: ref, set: boxRecord.pick({ owner: true, mayHost: true, lentTo: true, labels: true, alwaysOn: true, reportOnly: true }).partial().strict() }).strict(),
    output: z.object({ box: ref }),
    may: viewer => mayAct(viewer, { type: 'runtime.box' }, sharing(), 'household'),
    run(ctx, input) {
      const before = resolveBox(store, input.box);
      if (input.set.owner !== undefined && !Object.hasOwn(sharing().members, input.set.owner)) throw new OperationError('invalid', 'Box owner must be a household member');
      const after = { ...before, ...input.set };
      // Preserve the configured watch flag; report-only implies watching via boxAlwaysOn.
      after.reportOnly = !after.local && after.reportOnly;
      after.alwaysOn = after.local || after.alwaysOn;
      if (store.put('box', after, ctx.now)) ctx.changed('runtime.box', after.id);
      return { box: after.id };
    },
  }));
  operations.register(operation({
    name: 'runtime.setBoxes', write: true,
    input: z.object({ agent: ref, boxes: z.array(ref).max(8) }).strict(),
    output: z.object({ agent: ref, boxes: z.array(ref) }),
    may: (viewer, input) => mayAct(viewer, { type: 'runtime.settings', agent: input.agent }, sharing(), 'agent-setup'),
    run(ctx, input) {
      const boxes = input.boxes.map(b => resolveBox(store, b));
      if (new Set(boxes.map(b => b.id)).size !== boxes.length) throw new OperationError('invalid', 'A box is named twice');
      for (const b of boxes) if (!canHost(b, input.agent, sharing())) throw new OperationError('conflict', 'A preferred box may not host this agent');
      // Empty means default placement; no imaginary local machine is introduced.
      const ids = boxes.length === 1 && boxes[0].local ? [] : boxes.map(b => b.id);
      const existing = store.read('settings', input.agent);
      const record = { ...(existing ? withoutTimestamp(existing) : {}), id: input.agent, agent: input.agent, boxes: ids };
      if (store.put('settings', record, ctx.now)) ctx.changed('runtime.settings', input.agent);
      return { agent: input.agent, boxes: ids };
    },
  }));
}
