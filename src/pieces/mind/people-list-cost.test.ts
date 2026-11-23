/** One listing of people reads the household's sharing facts once, however many people it lists.
 *
 * Every live selection is read again after each write, and a listing used to read the sharing facts (whole
 * tables) several times for every person: with a browser open, the server spent all its time there (2026-11-19). */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { PeopleStore } from '../../backends/people.js';
import { ProjectsStore } from '../../backends/projects.js';
import { peopleReader } from './people.js';
import type { Sharing, Viewer } from '../../core/index.js';

it('reads the sharing facts once for a whole listing, and afresh for each listing and each single read', () => {
  const home = mkdtempSync(join(tmpdir(), 'loom-people-cost-'));
  try {
    const directory = join(home, 'agents/fiction'), memories = join(directory, 'memories.db'); mkdirSync(directory, { recursive: true });
    const store = new PeopleStore({ dbPath: memories, actor: 'fiction' });
    for (let n = 0; n < 12; n++) store.write({ slug: `friend-${n}`, name: `Fictional friend ${n}`, where: { pond: { value: 'Fictional' } } });
    store.close();
    const projects = new ProjectsStore({ dbPath: memories }); projects.write({ slug: 'pond', name: 'Fictional pond' }); projects.close();
    let asked = 0, owns = true;
    const sharing = (): Sharing => { asked++; return { members: { owner: { owner: false, agents: owns ? ['fiction'] : [] } }, projects: {}, agents: ['fiction'] }; };
    const people = peopleReader({ agents: [{ agent: 'fiction', memories }], sharing, now: () => Date.parse('2026-11-19T12:00:00Z') });
    const viewer: Viewer = { kind: 'member', id: 'owner' };
    try {
      expect(people.access(viewer).agents).toEqual(['fiction']);
      expect(asked).toBe(1);
      asked=0;
      const listed = people.list(viewer);
      expect(listed).toHaveLength(12);
      expect(listed[0].projects).toEqual([expect.objectContaining({ slug: 'pond' })]);
      expect(asked).toBe(1);
      // The facts are not kept past the listing: a change shows in the very next one, and in a single read.
      owns = false; asked = 0;
      expect(people.list(viewer)).toEqual([]);
      expect(people.read('fiction:friend-0', viewer)).toBeUndefined();
      owns = true;
      expect(people.read('fiction:friend-0', viewer)?.name).toBe('Fictional friend 0');
      expect(people.list(viewer)).toHaveLength(12);
    } finally { people.close(); }
  } finally { rmSync(home, { recursive: true, force: true }); }
});
