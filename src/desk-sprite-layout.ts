/** Shared opaque sprite-layout format; pure in browser and server. */
export const SPRITE_FACINGS = ['south', 'south-east', 'south-west'] as const;
export const SPRITE_STATES = ['idle', 'working', 'thinking', 'waiting', 'done', 'error', 'talking'] as const;
export type SpriteFacing = typeof SPRITE_FACINGS[number];
export type SpriteVariant = { sheet?: string; row: number; frames: number; weight: number; rare?: boolean; /** the frame it rests on (default: 0; error's, 4 from its end) */ rest?: number };
export type SpriteManifest = { cell: [number, number]; states: Partial<Record<typeof SPRITE_STATES[number], Partial<Record<SpriteFacing, SpriteVariant[]>>>>;
  /** Drawn smaller or larger than the others (0.5 to 1.2; default 1: past 1.2 a 2x face overruns its card's room), so a sprite that fills more of its cell reads the same size. */
  scale?: number;
  /** Moved, in the sheet's own pixels (x right, y down; each -32 to 32), so it sits where the others do. */
  offset?: [number, number];
  /** A small avatar's crop of the rest frame (idle, south, frame 0), in the cell's pixels. */
  avatar?: { x: number; y: number; w: number; h: number } };
export const SPRITE_MAX_BYTES = 4 * 1024 * 1024;
export const SPRITE_SHEET_NAME = /^[a-z0-9][a-z0-9-]{0,40}\.png$/;
export function checkSpriteLayout(raw: unknown, error: (message:string)=>Error = message=>new Error(message)): SpriteManifest {
  const bad = (why: string): never => { throw error(`that sprite manifest ${why}`); };
  const m = raw as { cell?: unknown; states?: unknown };
  if (!m || typeof m !== 'object') bad('isn\'t a JSON object');
  const cell = m.cell;
  if (!Array.isArray(cell) || cell.length !== 2 || !cell.every((n) => Number.isInteger(n) && n > 0 && n <= 512)) bad('needs "cell": [width, height]');
  if (!m.states || typeof m.states !== 'object') bad('needs "states"');
  const { scale, offset, avatar } = m as { scale?: unknown; offset?: unknown; avatar?: unknown };
  if (scale !== undefined && !(typeof scale === 'number' && scale >= 0.5 && scale <= 1.2)) bad('has a "scale" that isn\'t a number from 0.5 to 1.2');
  if (offset !== undefined && !(Array.isArray(offset) && offset.length === 2 && offset.every((n) => Number.isInteger(n) && n >= -32 && n <= 32))) bad('has an "offset" that isn\'t [x, y], whole pixels from -32 to 32');
  const [cw, ch] = cell as [number, number];
  let crop: SpriteManifest['avatar'];
  if (avatar !== undefined) {
    const { x, y, w, h } = (avatar ?? {}) as Record<string, unknown>;
    const whole = [x, y, w, h].every((n) => Number.isInteger(n));
    const [ax, ay, aw, ah] = [x, y, w, h] as number[];
    if (!whole || ax < 0 || ay < 0 || aw < 8 || ah < 8 || ax + aw > cw || ay + ah > ch) bad('has an "avatar" that isn\'t { x, y, w, h }: whole pixels inside the cell, 8 or more across');
    crop = { x: ax, y: ay, w: aw, h: ah };
  }
  const out: SpriteManifest = { cell: cell as [number, number], states: {},
    ...(crop ? { avatar: crop } : {}),
    ...(scale !== undefined && scale !== 1 ? { scale: scale as number } : {}),
    ...(offset !== undefined && (offset as number[]).some((n) => n !== 0) ? { offset: offset as [number, number] } : {}) };
  for (const [st, byFacing] of Object.entries(m.states as Record<string, unknown>)) {
    if (!(SPRITE_STATES as readonly string[]).includes(st)) bad(`names a state loom doesn't have (${st})`);
    if (!byFacing || typeof byFacing !== 'object') bad(`has no facings for ${st}`);
    for (const [f, list] of Object.entries(byFacing as Record<string, unknown>)) {
      if (!(SPRITE_FACINGS as readonly string[]).includes(f)) bad(`names a facing loom doesn't use (${f})`);
      if (st === 'waiting' && f !== 'south') bad('turns waiting away from south (waiting on you always faces you)');
      if (!Array.isArray(list) || !list.length) bad(`has no animations for ${st} ${f}`);
      const vs = (list as unknown[]).map((v) => {
        const x = v as SpriteVariant;
        if (!x || !Number.isInteger(x.row) || x.row < 0 || !Number.isInteger(x.frames) || x.frames < 1 || x.frames > 256 || typeof x.weight !== 'number' || !(x.weight > 0)) bad(`has an animation in ${st} ${f} without a row, frames and a weight`);
        if (x.sheet !== undefined && (typeof x.sheet !== 'string' || !SPRITE_SHEET_NAME.test(x.sheet))) bad(`names a sheet that isn't a plain .png name (${String(x.sheet)})`);
        if (x.rare !== undefined && typeof x.rare !== 'boolean') bad(`has an animation in ${st} ${f} whose "rare" isn't true or false`);
        if (x.rest !== undefined && (!Number.isInteger(x.rest) || x.rest < 0 || x.rest >= x.frames)) bad(`has an animation in ${st} ${f} whose "rest" isn't one of its frames`);
        return { ...(x.sheet && x.sheet !== 'sheet.png' ? { sheet: x.sheet } : {}), row: x.row, frames: x.frames, weight: x.weight, ...(x.rare ? { rare: true } : {}), ...(x.rest !== undefined ? { rest: x.rest } : {}) };
      });
      ((out.states[st as keyof SpriteManifest['states']] ??= {}) as Record<string, SpriteVariant[]>)[f] = vs;
    }
  }
  if (!out.states.idle?.south) bad('needs idle facing south (every pixel face has it)');
  return out;
}
/** The sheet files a manifest uses. */
export const spriteSheets = (m: SpriteManifest): string[] =>
  [...new Set(Object.values(m.states).flatMap((byF) => Object.values(byF ?? {}).flat().map((v) => v!.sheet ?? 'sheet.png')))];

