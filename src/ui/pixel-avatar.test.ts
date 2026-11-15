/** Avatar math; live asset selection and rendering are covered on the shared desk. */
import {describe,it,expect} from 'vitest';
import {avatarCrop,avatarFit,avatarHalf} from '../../web/src/pixel-face';
import {checkSpriteManifest,HouseholdError} from '../household.js';
describe('a small pixel avatar', () => {
  it('is the head: 32 pixels square over the top of what\'s drawn, centred on its head, unless the manifest names its crop', () => {
    const m = { cell: [56, 84] as [number, number], states: { idle: { south: [{ row: 7, frames: 17, weight: 1 }] } } };
    // The fixture's figure: x 10 to 45, y 20 to 63.
    expect(avatarCrop(m, (x, y) => x >= 10 && x < 46 && y >= 20 && y < 64)).toEqual({ x: 12, y: 20, w: 32, h: 32 });
    // A head narrower than the shoulders under it (x 20 to 35 for 16 rows, then x 4 to 51): centred on the head.
    expect(avatarCrop(m, (x, y) => y >= 20 && y < 64 && (y < 36 ? x >= 20 && x < 36 : x >= 4 && x < 52))).toEqual({ x: 12, y: 20, w: 32, h: 32 });
    expect(avatarCrop(m, (x, y) => y >= 20 && y < 64 && (y < 36 ? x >= 30 && x < 46 : x >= 4 && x < 52))).toEqual({ x: 22, y: 20, w: 32, h: 32 });
    expect(avatarCrop(m, () => false)).toEqual({ x: 12, y: 0, w: 32, h: 32 });
    expect(avatarCrop({ ...m, avatar: { x: 4, y: 6, w: 32, h: 32 } }, () => true)).toEqual({ x: 4, y: 6, w: 32, h: 32 });
  });
  it('a manifest\'s crop is kept, checked: whole pixels inside the cell, 8 or more across', () => {
    const m = { cell: [56, 84], states: { idle: { south: [{ row: 7, frames: 17, weight: 1 }] } } };
    expect(checkSpriteManifest({ ...m, avatar: { x: 4, y: 6, w: 32, h: 32 } }).avatar).toEqual({ x: 4, y: 6, w: 32, h: 32 });
    expect(checkSpriteManifest(m).avatar).toBeUndefined();
    for (const avatar of [{ x: 40, y: 0, w: 24, h: 24 }, { x: 0, y: 0, w: 4, h: 24 }, { x: 0.5, y: 0, w: 24, h: 24 }, { x: 0, y: 0, w: 24 }, 'top'])
      expect(() => checkSpriteManifest({ ...m, avatar }), JSON.stringify(avatar)).toThrow(HouseholdError);
  });
  it('is drawn at a whole-pixel scale: the head itself from 28 px, at half its resolution below (t-1925: never its middle)', () => {
    expect([20, 24, 27, 28, 32, 35, 48, 64].map((s) => avatarFit(s, 32))).toEqual([
      { half: true, k: 1 }, { half: true, k: 1 }, { half: true, k: 1 }, { half: false, k: 1 }, { half: false, k: 1 }, { half: false, k: 1 },
      { half: false, k: 1 }, { half: false, k: 2 }]);
  });
  it('at half resolution, each 2x2 is one pixel: its drawn pixels\' average when two or more are drawn, else nothing', () => {
    const px = (...c: number[][]) => new Uint8ClampedArray(c.flat());
    const A = [200, 0, 0, 255], B = [0, 100, 0, 255], _ = [0, 0, 0, 0];
    // 4x2: a block of two drawn (A, B) and two empty, then a block of one drawn.
    const h = avatarHalf(px(A, _, A, _, B, _, _, _), 4, 2);
    expect([h.w, h.h, [...h.data]]).toEqual([2, 1, [100, 50, 0, 255, 0, 0, 0, 0]]);
  });
});
