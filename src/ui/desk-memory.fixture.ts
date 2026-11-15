/** Disposable source inventory for the actual shared desk browser proof. */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PeopleStore } from '../backends/people.js';
import type { MindSources } from '../pieces/mind/sources.js';

export function deskMemoryFixture(agents: readonly string[]) {
  const home = mkdtempSync(join(tmpdir(), 'desk-memory-'));
  const directory = join(home, 'commons');
  const sources: MindSources = {
    commons: { directory, knowledge: join(directory, 'knowledge.db'), people: join(directory, 'people.db') },
    agents: agents.map(agent => {
      const directory = join(home, 'agents', agent);
      return { agent, directory, memories: join(directory, 'memories.db') };
    }),
  };
  try {
    mkdirSync(directory, { recursive: true });
    const people = new PeopleStore({ dbPath: sources.commons.people, actor: 'fictional-desk' });
    try { people.write({ slug: 'art', name: 'Household Art', how: { kind: 'agent' } }); }
    finally { people.close(); }
    return { sources, name: 'Household Art', close: () => rmSync(home, { recursive: true, force: true }) };
  } catch (error) {
    rmSync(home, { recursive: true, force: true });
    throw error;
  }
}
