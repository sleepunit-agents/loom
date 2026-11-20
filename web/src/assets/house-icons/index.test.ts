import { expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { HOUSE_ICONS } from './index';

const dir = import.meta.dirname;
const files = readdirSync(dir).filter(f => f.endsWith('.png'));
/** A PNG's header: its size, bit depth and colour type (0 is greyscale). */
const header = (file: string) => { const b = readFileSync(path.join(dir, file)); return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), depth: b[24], colour: b[25] }; };

it('lists exactly the icons whose files are beside it, each with its small file', () => {
  const apps = files.filter(f => !f.endsWith('.small.png')).map(f => f.slice(0, -'.png'.length)).sort();
  expect(Object.keys(HOUSE_ICONS).sort()).toEqual(apps);
  expect(files.filter(f => f.endsWith('.small.png')).map(f => f.slice(0, -'.small.png'.length)).sort()).toEqual(apps);
  expect(apps).toEqual(expect.arrayContaining(['approvals', 'changes', 'comms', 'inbox', 'tasks', 'tempo']));
  for (const app of apps) {
    expect(app, 'an app id').toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(HOUSE_ICONS[app].art, app).toContain(`${app}.png`);
    expect(HOUSE_ICONS[app].small, app).toContain(`${app}.small.png`);
    expect(HOUSE_ICONS[app].art).not.toMatch(/^data:/);
  }
});
it('keeps each icon as 8-bit greyscale, 128 px and 32 px, with the art it was made from', () => {
  for (const app of Object.keys(HOUSE_ICONS)) {
    expect(header(`${app}.png`), app).toEqual({ w: 128, h: 128, depth: 8, colour: 0 });
    expect(header(`${app}.small.png`), app).toEqual({ w: 32, h: 32, depth: 8, colour: 0 });
    expect(existsSync(path.join(dir, 'source', `${app}-src.png`)), `${app}'s art in source/`).toBe(true);
  }
  expect(readdirSync(path.join(dir, 'source')).sort()).toEqual(Object.keys(HOUSE_ICONS).sort().map(app => `${app}-src.png`));
});
