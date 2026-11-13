/** Only the stopped-home importer reads legacy sprite files. */
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { AGENT_NAME, checkSpriteManifest, spriteSheets } from '../household.js';
import { spriteKey, type StoredSprite } from '../core/household/sprites.js';
const MAX = 4 * 1024 * 1024;
const MAGIC = Buffer.from([137,80,78,71,13,10,26,10]);
/** Named assets only, bounded regular files, contained by the source home. */
export function snapshotSprites(home: string, agents: string[]): Map<string, Buffer> {
  const files = new Map<string, Buffer>(), root = realpathSync(home);
  const read = (path: string, optional = false): Buffer | undefined => {
    const full = join(root, path);
    let stat;
    try { stat = lstatSync(full); } catch (e) { if (optional && (e as NodeJS.ErrnoException).code === 'ENOENT') return; throw e; }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX || !realpathSync(full).startsWith(root + sep)) throw Error('Sprite source must be a bounded regular file inside the source home');
    const body = readFileSync(full); if (body.length > MAX) throw Error('Sprite source exceeds size limit');
    files.set(path, body); return body;
  };
  for (const agent of agents) {
    if (!AGENT_NAME.test(agent)) throw Error('Invalid sprite agent');
    const base = `faces/${agent}/`, bytes = read(base + 'manifest.json', true);
    if (!bytes) continue;
    const m = checkSpriteManifest(JSON.parse(bytes.toString('utf8')));
    for (const name of spriteSheets(m)) {
      const png = read(base + name)!;
      if (png.length < 24 || !png.subarray(0,8).equals(MAGIC) || png.toString('ascii',12,16) !== 'IHDR') throw Error('Sprite sheet is not a PNG');
      const w = png.readUInt32BE(16), h = png.readUInt32BE(20);
      if (!w || !h || w * h > 32 * 1024 * 1024) throw Error('Sprite sheet dimensions exceed limit');
      for (const byFacing of Object.values(m.states)) for (const variants of Object.values(byFacing ?? {})) for (const v of variants ?? []) {
        if ((v.sheet ?? 'sheet.png') === name && (v.frames * m.cell[0] > w || (v.row + 1) * m.cell[1] > h)) throw Error('Sprite animation exceeds sheet dimensions');
      }
    }
  }
  return files;
}
export function spriteRows(files: Map<string, Buffer | undefined>): Array<[string, StoredSprite]> {
  return [...files].filter(([p]) => /^faces\/[^/]+\/manifest\.json$/.test(p)).map(([path, bytes]) => {
    const manifest = checkSpriteManifest(JSON.parse(bytes!.toString('utf8'))), base = path.slice(0, -'manifest.json'.length);
    const sheets = Object.fromEntries(spriteSheets(manifest).map(name => [name, files.get(base + name)!.toString('base64')]));
    const v = createHash('sha256').update(bytes!).update(JSON.stringify(sheets)).digest('hex');
    return [spriteKey(path.split('/')[1]), { manifest, sheets, v }];
  });
}
