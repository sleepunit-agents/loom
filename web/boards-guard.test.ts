/** ./boards-guard.ts, the boards page's bundle guard: what it lets into the page and what fails the build. The build
 * itself (vite.boards.config.ts) hands it every module id of the graph with its imports; here the graph is written
 * out by hand, as rolldown names its modules. */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { boardsGuard, outside, type Seen } from './boards-guard.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const at = (path: string) => root + path;
const shape = at('src/core/boards/value-shape.ts');
/** The page as it is: its entry, a brick, the shape module with no import, kit.ts that imports it and zod. */
const page: Seen[] = [
  { id: at('web/board.html'), imports: ['\0vite/modulepreload-polyfill.js', at('web/src/boards/main.tsx')] },
  { id: '\0vite/modulepreload-polyfill.js', imports: [] },
  { id: '\0rolldown/runtime.js', imports: [] },
  { id: at('web/src/boards/main.tsx'), imports: [at('web/src/boards/bricks-household.tsx')] },
  { id: at('web/src/boards/bricks-household.tsx'), imports: [shape, at('web/src/pieces/household/model.ts')] },
  { id: at('web/src/pieces/household/model.ts'), imports: [] },
  { id: shape, imports: [] },
  { id: at('src/core/boards/bricks/kit.ts'), imports: [at('node_modules/zod/index.js'), shape] },
  { id: at('node_modules/zod/index.js'), imports: [] },
];

it('takes the page as it is', () => {
  expect(boardsGuard(page, root)).toEqual([]);
});

it('fails the build when the shape module imports anything, a file the page may load or not', () => {
  const importing = (to: string): Seen[] => page.map((m) => (m.id === shape ? { ...m, imports: [to] } : m));
  // What the first review found: a server runtime module reached through the shape module.
  expect(boardsGuard([...importing(at('src/runtime/fixed-program.ts')), { id: at('src/runtime/fixed-program.ts'), imports: [] }], root)).toEqual([
    'A plain file imports in boards page: src/core/boards/value-shape.ts imports src/runtime/fixed-program.ts',
    'Server file in boards page: src/runtime/fixed-program.ts',
  ]);
  // Even a file the page may load, or a package: the module is plain, so the page and the server load it alone.
  expect(boardsGuard(importing(at('src/core/boards/bricks/kit.ts')), root)).toEqual(['A plain file imports in boards page: src/core/boards/value-shape.ts imports src/core/boards/bricks/kit.ts']);
  expect(boardsGuard(importing(at('node_modules/zod/index.js')), root)).toEqual(['A plain file imports in boards page: src/core/boards/value-shape.ts imports node_modules/zod/index.js']);
  // A `node:` module, which vite replaces with an empty stand-in for the browser.
  expect(boardsGuard([...importing('__vite-browser-external'), { id: '__vite-browser-external', imports: [] }], root)).toEqual([
    'A plain file imports in boards page: src/core/boards/value-shape.ts imports __vite-browser-external',
    'Not a file of this repository in boards page: __vite-browser-external',
  ]);
});

it('fails the build for a server file not named, a desktop file, and anything from elsewhere', () => {
  expect(boardsGuard([...page, { id: at('src/runtime/body-harness.ts'), imports: [] }], root)).toEqual(['Server file in boards page: src/runtime/body-harness.ts']);
  expect(boardsGuard([...page, { id: at('web/src/kit/index.ts'), imports: [] }], root)).toEqual(['Desktop dependency in boards page: kit/index.ts']);
  expect(boardsGuard([...page, { id: at('scripts/ci-sequencer.js'), imports: [] }], root)).toEqual(['Not a page file in boards page: scripts/ci-sequencer.js']);
  expect(boardsGuard([...page, { id: '\0virtual:anything', imports: [] }], root)).toEqual(['Not a file of this repository in boards page: \0virtual:anything']);
});

it('names only files that exist, and the shape module as plain', () => {
  for (const path of outside.keys()) expect(existsSync(at(path)), path).toBe(true);
  expect(outside.get('src/core/boards/value-shape.ts')?.plain).toBe(true);
});
