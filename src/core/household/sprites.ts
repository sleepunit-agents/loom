/** Imported artwork belongs to the new database; request paths never discover old files. */
import type { Db } from '../db/index.js';
import { HouseholdRows } from './rows.js';
import { SPRITE_FACINGS, type SpriteManifest } from '../../household.js';
export type StoredSprite = { manifest: SpriteManifest; rawManifest: string; sheets: Record<string, string>; v: string };
export const spriteKey = (agent: string) => `agent-sprite:${agent}`;
export const storedSprite = (db: Db, agent: string) => new HouseholdRows<StoredSprite>(db, 'settings').get(spriteKey(agent));
export function spriteDisplay(db: Db, agent: string) {
  const sprite = storedSprite(db, agent);
  return sprite && { facings: SPRITE_FACINGS.filter(f => Object.values(sprite.manifest.states).some(s => s?.[f]?.length)),
    v: sprite.v, base: `/faces/${agent}/` };
}
