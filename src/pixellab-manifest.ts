import { SPRITE_FACINGS, SPRITE_STATES, checkSpriteLayout, type SpriteManifest, type SpriteVariant } from './desk-sprite-layout.js';

/**
 * A manifest seeded from a PixelLab export: each state's rows by their names (Error, Idle, Thinking, Done, Waiting; a
 * row named by a whole prompt is Working), one animation per state and facing, weight 1 unless `weights` says; waiting
 * south only. Any other named row is an extra animation only if `variants` places it (its state, weight, and rare or not).
 */
export function manifestFromPixelLab(meta: unknown, opts: { weights?: Record<string, number>; variants?: Record<string, { state: string; weight: number; rare?: boolean }> } = {}): SpriteManifest {
  const sh = (meta as { spritesheet?: { cell_size?: { width?: number; height?: number }; columns?: number; rows?: Array<{ row: number; type?: string; animation?: string; direction?: string; frame_count?: number }> } })?.spritesheet;
  if (!sh?.cell_size?.width || !sh.cell_size.height || !Array.isArray(sh.rows)) throw new Error('that JSON isn\'t a PixelLab sprite sheet\'s (spritesheet.cell_size, rows)');
  const named: Record<string, typeof SPRITE_STATES[number]> = { error: 'error', idle: 'idle', thinking: 'thinking', done: 'done', waiting: 'waiting', working: 'working', talking: 'talking' };
  const states: Record<string, Record<string, SpriteVariant[]>> = {};
  const extra = Object.fromEntries(Object.entries(opts.variants ?? {}).map(([k, v]) => [k.trim().toLowerCase(), v]));
  for (const r of sh.rows.filter((x) => x.type === 'animation')) {
    const name = (r.animation ?? '').trim();
    const x = extra[name.toLowerCase()];
    // PixelLab names a row by its animation, or by its whole prompt (Working's describes what it does).
    const st = x?.state ?? (Object.hasOwn(named,name.toLowerCase()) ? named[name.toLowerCase()] : undefined) ?? (name.split(/\s+/).length > 6 ? 'working' : undefined);
    const f = r.direction ?? 'south';
    if (!st || !(SPRITE_FACINGS as readonly string[]).includes(f) || (st === 'waiting' && f !== 'south')) continue;
    const v: SpriteVariant = { row: r.row, frames: r.frame_count ?? sh.columns ?? 1, weight: x ? x.weight : opts.weights?.[st] ?? 1, ...(x?.rare ? { rare: true } : {}) };
    ((states[st] ??= {})[f] ??= []).push(v);
  }
  return checkSpriteLayout({ cell: [sh.cell_size.width, sh.cell_size.height], states });
}
