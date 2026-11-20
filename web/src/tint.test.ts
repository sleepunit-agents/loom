import { expect, it } from 'vitest';
import { APP_TINTS, tintOf } from './tint';
import { sharingApp } from './pieces/sharing/registration';
import { appearanceApp } from './pieces/appearance/registration';

// The how-it-works site draws Tempo and Sharing violet, which is olive here; a name's hash gave them other colours.
it('gives Tempo and Sharing the site’s colour, by the names their tiles carry', () => {
  expect(APP_TINTS).toMatchObject({ Tempo: 'olive', Sharing: 'olive' });
  expect(sharingApp.title).toBe('Sharing');
  expect(tintOf(sharingApp.title)).toBe('olive');
  expect(tintOf('Tempo')).toBe('olive');
  expect(tintOf(appearanceApp.title)).toBe('pink');
});
