import { z } from 'zod';
import type { Foundation } from '../app.js';
import { operation, OperationError } from '../operations/index.js';
import { mayAct, maySee, type Viewer } from '../../policy.js';
import { HouseholdDatabase } from './document.js';
import { HouseholdRows } from './rows.js';
import { SharingDatabase } from './sharing.js';

/** The choices accepted by the old Appearance endpoint; server time is never caller supplied. */
export const preferenceChoices = z.object({
  look: z.enum(['neon', 'lowlight', 'daylight', '000h']).optional(),
  mode: z.enum(['auto', 'light', 'dark']).optional(),
  ground: z.enum(['depth', 'contours', 'wash']).optional(),
  sound: z.boolean().optional(), pixel: z.boolean().optional(), icons: z.boolean().optional(),
  haptics: z.boolean().optional(), tiling: z.boolean().optional(), oneWindow: z.boolean().optional(),
  zoom: z.boolean().optional(), motion: z.enum(['follow', 'on', 'off']).optional(),
  contrast: z.enum(['follow', 'on', 'off']).optional(),
}).strict();
export const preferencesSchema = preferenceChoices.extend({ at: z.number().finite().optional() });
type Preferences = z.infer<typeof preferencesSchema>;
type Reader = Record<string, unknown> & { prefs?: Record<string, unknown> };

/** Project a whitelist, never the reader's Inbox state or unknown imported fields. */
function project(raw: Record<string, unknown> = {}): Preferences {
  const out: Record<string, unknown> = {};
  for (const [key, schema] of Object.entries(preferencesSchema.shape)) {
    const parsed = schema.safeParse(raw[key]);
    if (parsed.success && parsed.data !== undefined) out[key] = parsed.data;
  }
  if (raw.look !== undefined) out.look = raw.look === '000h' ? (raw.mode === 'light' ? 'daylight' : 'lowlight')
    : ['neon', 'lowlight', 'daylight'].includes(String(raw.look)) ? raw.look : 'neon';
  if (out.oneWindow === undefined && out.tiling === false) out.oneWindow = true;
  return out as Preferences;
}

export function installHouseholdPreferences(app: Foundation, home: string): void {
  const household = new HouseholdDatabase(app.db), sharing = new SharingDatabase(app.db, home);
  const readers = new HouseholdRows<Reader>(app.db, 'readers');
  const settings = new HouseholdRows<Reader>(app.db, 'settings');
  const allowed = (v: Viewer, write = false) => {
    const scope = { member: v.id };
    return write ? mayAct(v, scope, sharing.sharing()) : maySee(v, scope, sharing.sharing());
  };
  // Match the imported session reader mapping: the first full owner uses the envelope.
  function row(member: string) {
    const h = household.household(home);
    if (!h) throw new OperationError('unavailable', 'Household has not been imported');
    return h.members.find(m => m.agents === '*')?.person === member
      ? { rows: settings, id: 'session-envelope' } : { rows: readers, id: member };
  }
  const read = (member: string) => { const r = row(member); return project(r.rows.get(r.id)?.prefs); };
  app.operations.register(operation({
    name: 'household.preferences', input: z.object({}).strict(), output: preferencesSchema,
    may: v => allowed(v), run: ctx => read(ctx.viewer.id),
  }));
  app.operations.register(operation({
    name: 'household.setPreferences', write: true,
    input: preferenceChoices.refine(p => Object.keys(p).length > 0, 'Choose a preference to save'),
    output: preferencesSchema, may: v => allowed(v, true),
    run(ctx, input) {
      const r = row(ctx.viewer.id), before = r.rows.get(r.id) ?? {};
      const oldAt = typeof before.prefs?.at === 'number' && Number.isFinite(before.prefs.at) ? before.prefs.at : 0;
      const prefs = { ...before.prefs, ...input, at: Math.max(ctx.now, oldAt + 1) };
      r.rows.put(r.id, { ...before, prefs });
      ctx.changed('household.preferences', ctx.viewer.id);
      return project(prefs);
    },
  }));
  app.live.register({
    name: 'household.preferences', ids: () => Object.keys(sharing.sharing().members),
    read(id, viewer) {
      if (!maySee(viewer, { member: id }, sharing.sharing())) return;
      return { id, member: id, prefs: read(id) };
    },
    inScope: (_record, scope) => scope === undefined,
  });
}
