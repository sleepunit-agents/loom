/** Retained layout/player checks; shipped pixels are proved in the shared desk scenario. */
import {it,expect} from 'vitest';
import {manifestFromPixelLab,checkSpriteManifest,HouseholdError} from '../household.js';
import {pick,variantsFor} from '../../web/src/pixel-face';
import {sheet} from './pixel-sheet.fixture.js';
it('a manifest seeded from PixelLab: each state in each facing, one animation, weight 1; waiting south only', () => {
    const m = manifestFromPixelLab(JSON.parse(sheet().json.toString()));
    expect(m.cell).toEqual([56, 84]);
    expect(m.states.idle).toEqual({ south: [{ row: 7, frames: 17, weight: 1 }], 'south-east': [{ row: 8, frames: 17, weight: 1 }], 'south-west': [{ row: 9, frames: 17, weight: 1 }] });
    expect(m.states.working?.south).toEqual([{ row: 4, frames: 17, weight: 1 }]);
    expect(m.states.waiting).toEqual({ south: [{ row: 16, frames: 17, weight: 1 }] });
    // A named animation that isn't a state is left out unless placed: Art's neck crack, a rare idle.
    expect(Object.values(m.states).flatMap((f) => Object.values(f!).flat()).some((v) => v!.row >= 19)).toBe(false);
    const art = manifestFromPixelLab(JSON.parse(sheet().json.toString()), { weights: { idle: 85 }, variants: { 'Crack Neck': { state: 'idle', weight: 15, rare: true } } });
    expect(art.states.idle).toEqual({
      south: [{ row: 7, frames: 17, weight: 85 }, { row: 19, frames: 17, weight: 15, rare: true }],
      'south-east': [{ row: 8, frames: 17, weight: 85 }, { row: 20, frames: 17, weight: 15, rare: true }],
      'south-west': [{ row: 9, frames: 17, weight: 85 }, { row: 21, frames: 17, weight: 15, rare: true }],
    });
    expect(() => checkSpriteManifest({ cell: [56, 84], states: { idle: { south: [{ row: 7, frames: 17, weight: 1 }] }, waiting: { 'south-east': [{ row: 17, frames: 17, weight: 1 }] } } })).toThrow(HouseholdError);
    expect(() => checkSpriteManifest({ cell: [56, 84], states: { idle: { east: [{ row: 7, frames: 17, weight: 1 }] } } })).toThrow(HouseholdError);
    expect(() => checkSpriteManifest({ cell: [56, 84], states: { idle: { south: [{ sheet: '../x.png', row: 0, frames: 2, weight: 1 }] } } })).toThrow(HouseholdError);
    expect(() => checkSpriteManifest({ cell: [56, 84], states: { idle: { south: [{ row: 0, frames: 2, weight: 1, rare: 'yes' }] } } })).toThrow(HouseholdError);
  });

it('a face\'s own scale and offset are kept (t-1849: Mark\'s reads bigger than Art\'s), checked, and left out when they change nothing', () => {
    const idle = { idle: { south: [{ row: 7, frames: 17, weight: 1 }] } };
    expect(checkSpriteManifest({ cell: [96, 80], states: idle, scale: 0.85, offset: [0, 3] })).toMatchObject({ scale: 0.85, offset: [0, 3] });
    const plain = checkSpriteManifest({ cell: [96, 80], states: idle, scale: 1, offset: [0, 0] });
    expect('scale' in plain || 'offset' in plain).toBe(false);
    for (const bad of [{ scale: 0.2 }, { scale: 1.3 }, { scale: '0.9' }, { offset: [0] }, { offset: [0, 40] }, { offset: [0.5, 0] }])
      expect(() => checkSpriteManifest({ cell: [96, 80], states: idle, ...bad })).toThrow(HouseholdError);
  });

it('picks an animation by weight at each beat, never the same rare one twice in a row; a facing with none uses south', () => {
    const usual = { row: 7, frames: 17, weight: 85 }, rare = { sheet: 'idle-rare.png', row: 0, frames: 12, weight: 15, rare: true };
    const m = { cell: [56, 84] as [number, number], states: { idle: { south: [usual, rare], 'south-east': [{ row: 8, frames: 17, weight: 1 }] }, error: { south: [{ row: 1, frames: 17, weight: 1 }], 'south-east': [{ row: 2, frames: 17, weight: 1 }] }, waiting: { south: [{ row: 16, frames: 17, weight: 1 }] } } };
    expect(pick([usual, rare], undefined, 0.5)).toBe(usual);
    expect(pick([usual, rare], undefined, 0.9)).toBe(rare);
    expect(pick([usual, rare], rare, 0.99)).toBe(usual);   // after a rare one, never a rare one
    expect(pick([usual, rare], usual, 0.9)).toBe(rare);    // the usual one may be followed by a rare one
    expect(pick([usual, rare], usual, 0.5)).toBe(usual);   // and by itself
    let prev: typeof usual | undefined, twice = 0;
    for (let i = 0; i < 2000; i++) { const v = pick([usual, rare], prev); if (v === rare && prev === rare) twice++; prev = v; }
    expect(twice).toBe(0);
    let rares = 0;
    for (let i = 0; i < 2000; i++) if (pick([usual, rare], undefined) === rare) rares++;
    expect(rares / 2000).toBeGreaterThan(0.1); expect(rares / 2000).toBeLessThan(0.2);
    expect(variantsFor(m, 'idle', 'south-east')).toEqual({ list: m.states.idle['south-east'], flip: false });
    expect(variantsFor(m, 'error', 'south-west')).toEqual({ list: m.states.error['south-east'], flip: true });
    expect(variantsFor(m, 'idle', 'south-west')).toEqual({ list: m.states.idle['south-east'], flip: true });
    expect(variantsFor(m, 'thinking', 'south-east')).toEqual({ list: m.states.idle.south, flip: false });
    expect(variantsFor(m, 'needs-input', 'south-east')).toEqual({ list: m.states.waiting.south, flip: false });
    // With south-west rows anywhere in the face, a state without its own uses its south (no mirroring).
    const withSW = { ...m, states: { ...m.states, thinking: { south: [{ row: 10, frames: 17, weight: 1 }], 'south-west': [{ row: 12, frames: 17, weight: 1 }] } } };
    expect(variantsFor(withSW, 'error', 'south-west')).toEqual({ list: m.states.error.south, flip: false });
  });
