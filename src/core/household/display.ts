import type { Foundation } from '../app.js';
import { maySee } from '../../policy.js';
import { FACE_EYES, FACE_SHAPES, MARKS } from '../../household.js';
import { HouseholdDatabase } from './document.js';
import { SharingDatabase } from './sharing.js';

const object = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
/** Pure projection of imported metadata. Never discovers a household file or artwork. */
export function agentDisplay(raw: Record<string, unknown>, agent: string) {
  const agents = Array.isArray(raw.agents) ? raw.agents : [];
  if (!agents.includes(agent)) return;
  const at = Math.max(0, agents.indexOf(agent));
  const mark = object(object(raw.marks)[agent]), face = object(object(raw.faces)[agent]);
  const palette = MARKS.find(m => m.bg === mark.bg) ?? MARKS[at % MARKS.length];
  return { id: agent, agent, mark: { bg: palette.bg, fg: palette.fg },
    face: { shape: FACE_SHAPES.find(s => s === face.shape) ?? FACE_SHAPES[at % FACE_SHAPES.length],
      eyes: FACE_EYES.find(e => e === face.eyes) ?? FACE_EYES[at % FACE_EYES.length] } };
}

export function installHouseholdDisplay(app: Foundation, home: string) {
  const household = new HouseholdDatabase(app.db), sharing = new SharingDatabase(app.db, home);
  app.live.register({
    name: 'household.agentDisplay',
    ids: () => household.household(home)?.agents ?? [],
    read(id, viewer) {
      if (!maySee(viewer, { agent: id, type: 'household.agentDisplay' }, sharing.sharing())) return;
      const raw = household.document();
      return raw && agentDisplay(raw, id);
    },
    inScope: (_record, scope) => scope === undefined,
  });
}
