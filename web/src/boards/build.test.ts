import { expect, it } from 'vitest';
import { newerBuild } from './build';

const page = (src: string) => `<!doctype html><body><div id="root"></div><script type="module" crossorigin src="${src}"></script></body>`;
it('says a build is newer only when the served page runs another script', () => {
  expect(newerBuild(page('/app/boards-assets/board-A.js'), ['/app/boards-assets/board-A.js'])).toBe(false);
  expect(newerBuild(page('/app/boards-assets/board-B.js'), ['/app/boards-assets/board-A.js'])).toBe(true);
  // A sign-in page, an error page, or a page it cannot read is not a new build.
  expect(newerBuild('<html><body>Sign in</body></html>', ['/app/boards-assets/board-A.js'])).toBe(false);
  expect(newerBuild(page('/app/boards-assets/board-B.js'), [])).toBe(false);
});
