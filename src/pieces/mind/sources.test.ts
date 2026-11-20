import { afterEach, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFoundation } from '../../core/app.js';
import { migrateHouseholdTables } from '../../core/household/schema.js';
import { HouseholdDatabase } from '../../core/household/document.js';
import { mindSources } from './sources.js';

const homes: string[] = [];
const closes: Array<() => void> = [];
afterEach(() => { closes.splice(0).reverse().forEach(close => close()); homes.splice(0).forEach(home => rmSync(home, { recursive: true, force: true })); });
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'mind-sources-')); homes.push(home);
  const app = createFoundation({ home }); closes.push(() => app.close());
  migrateHouseholdTables(app.db);
  return { app, home, metadata: new HouseholdDatabase(app.db) };
}
it('uses only the database household and explicit home, without creating stores', () => {
  const { app, home, metadata } = fixture();
  writeFileSync(join(home, 'household.json'), '{invalid JSON');
  expect(mindSources(app.db, home)).toBeUndefined();
  app.db.transaction(() => metadata.replace(home, { v: 1, agents: ['art', 'mark'], default: 'art', owner: 'jonathan' }))();
  expect(mindSources(app.db, home)).toEqual({
    commons: { directory: join(home, 'commons'), knowledge: join(home, 'commons/knowledge.db'), people: join(home, 'commons/people.db') },
    agents: ['art', 'mark'].map(agent => ({ agent, directory: join(home, 'agents', agent), memories: join(home, 'agents', agent, 'memories.db') })),
  });
  expect(existsSync(join(home, 'commons'))).toBe(false);
  expect(existsSync(join(home, 'agents'))).toBe(false);
});
it('takes a fresh metadata snapshot and never retains a removed agent', () => {
  const { app, home, metadata } = fixture();
  const replace = (agents: string[]) => app.db.transaction(() => metadata.replace(home, { v: 1, agents, default: agents[0], owner: 'jonathan' }))();
  replace(['art', 'mark']);
  const previous = mindSources(app.db, home)!;
  replace(['mark']);
  expect(mindSources(app.db, home)!.agents.map(a => a.agent)).toEqual(['mark']);
  expect(previous.agents.map(a => a.agent)).toEqual(['art', 'mark']);
});
