/** Household descriptions are app metadata, never an agent's private creed. */
import { z } from 'zod';
import type { Foundation } from '../app.js';
import { OperationError } from '../operations/index.js';
import { householdOperation as operation } from './commands.js';
import { mayAct, maySee, type Viewer } from '../../policy.js';
import { AGENT_NAME, ABOUT_ASK_MS } from '../../household.js';
import { HouseholdDatabase } from './document.js';
import { SharingDatabase } from './sharing.js';
const object = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const agent = z.string().regex(AGENT_NAME);
export function installHouseholdProfiles(app: Foundation, home: string) {
  const store = new HouseholdDatabase(app.db), sharing = new SharingDatabase(app.db, home);
  const known = (id: string) => !!store.household(home)?.agents.includes(id);
  const setup = (v: Viewer, i: { agent: string }) => mayAct(v, { agent: i.agent, type: 'household.profile' }, sharing.sharing(), 'agent-setup');
  function read(id: string) {
    if (!known(id)) throw new OperationError('not-found', 'Unknown household agent');
    const raw = store.document()!, text = object(raw.about)[id], at = object(raw.aboutAsk)[id];
    const requested = typeof at === 'string' && Number.isFinite(Date.parse(at)) &&
      app.operations.clock.now() >= Date.parse(at) && app.operations.clock.now() < Date.parse(at) + ABOUT_ASK_MS;
    return { agent: id, ...(typeof text === 'string' && text.trim() ? { description: text.trim() } : {}), ...(requested ? { requestedAt: at as string } : {}) };
  }
  function change(id: string, description?: string, request = false) {
    if (!known(id)) throw new OperationError('not-found', 'Unknown household agent');
    store.change(home, raw => {
      const asks = { ...object(raw.aboutAsk) };
      if (request) asks[id] = new Date(app.operations.clock.now()).toISOString();
      else {
        const about = { ...object(raw.about) };
        if (description) about[id] = description; else delete about[id];
        raw.about = about; delete asks[id];
      }
      if (Object.keys(asks).length) raw.aboutAsk = asks; else delete raw.aboutAsk;
    });
    return read(id);
  }
  const normalize = (s: string) => s.replace(/\s+/g, ' ').trim();
  app.operations.register(operation({ name: 'household.profile', input: z.object({ agent }).strict(),
    may: (v, i) => maySee(v, { agent: i.agent, type: 'household.profile' }, sharing.sharing()), run: (_ctx, i) => read(i.agent),
  }));
  app.operations.register(operation({ name: 'household.setProfile', write: true,
    input: z.object({ agent, text: z.string().transform(normalize).pipe(z.string().max(600)) }).strict(), may: (v, i) => setup(v, i),
    run: (ctx, i) => { const result = change(i.agent, i.text); ctx.changed('household.profile', i.agent); return result; },
  }));
  app.operations.register(operation({ name: 'household.requestProfile', write: true, input: z.object({ agent }).strict(), may: (v, i) => setup(v, i),
    run: (ctx, i) => { const result = change(i.agent, undefined, true); ctx.changed('household.profile', i.agent); return result; },
  }));
  app.operations.register(operation({ name: 'household.describeSelf', write: true,
    input: z.object({ text: z.string().min(1).max(300).transform(normalize).pipe(z.string().min(1)) }).strict(),
    may: v => v.kind === 'agent' && known(v.id) && mayAct(v, { agent: v.id, type: 'household.profile' }, sharing.sharing()),
    run: (ctx, i) => {
      if (!read(ctx.viewer.id).requestedAt) throw new OperationError('denied', 'An owner must ask for a description first');
      if ((i.text.match(/[.!?](\s|$)/g) ?? []).length > 2) throw new OperationError('invalid', 'Keep it to one or two sentences');
      const result = change(ctx.viewer.id, i.text); ctx.changed('household.profile', ctx.viewer.id); return result;
    },
  }));
  app.live.register({ name: 'household.profile', ids: scope => scope === undefined ? store.household(home)?.agents ?? [] : [scope],
    read: (id, v) => known(id) && maySee(v, { agent: id, type: 'household.profile' }, sharing.sharing()) ? { id, ...read(id), canEdit: setup(v, { agent: id }) } : undefined,
    inScope: (r, scope) => scope === undefined || r.id === scope,
    expires: r => typeof r.requestedAt === 'string' ? Date.parse(r.requestedAt) + ABOUT_ASK_MS : undefined,
  });
}
