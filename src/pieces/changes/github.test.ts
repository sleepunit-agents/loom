import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { normalize } from './github.js';

const node = JSON.parse(readFileSync(new URL('./github.fixture.json', import.meta.url), 'utf8')).data.repository.open.nodes[0];

it('keeps the files GitHub lists with their line counts, each once, leaving out a malformed entry', () => {
  const files = { nodes: [
    { path: 'src/a.ts', additions: 4, deletions: 1 }, { path: 'src/b.ts', additions: 0, deletions: 7 },
    { path: 'src/a.ts', additions: 5, deletions: 1 }, null, { path: '', additions: 1, deletions: 1 },
    { path: 'src/c.ts', additions: -1, deletions: 0 }, { path: 'src/d.ts', additions: 1.5, deletions: 0 }, { path: 7, additions: 1, deletions: 1 },
  ] };
  expect(normalize('acme/app', { ...node, files }).files).toEqual([{ path: 'src/a.ts', additions: 5, deletions: 1 }, { path: 'src/b.ts', additions: 0, deletions: 7 }]);
  expect(normalize('acme/app', { ...node, files: { nodes: [] } }).files).toEqual([]);
});

it('says nothing of files when GitHub was not asked for them, so the stored ones are kept', () => {
  const { files: _files, ...without } = node;
  expect(normalize('acme/app', without)).not.toHaveProperty('files');
});
