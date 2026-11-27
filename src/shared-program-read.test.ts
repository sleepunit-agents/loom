import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { FakeClock } from './core/clock.js';
import { createDataSchema } from './core/data/database.js';
import { members, tokens } from './core/data/schema.js';
import { sharedRoot } from './shared-root.js';
import { readFileSync } from 'node:fs';

const clean: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of clean.splice(0).reverse()) await close(); });
// Exercise the shipped page selection without loading its React component.
const source = readFileSync(new URL('../web/src/pieces/household/model.ts', import.meta.url), 'utf8');
const query = source.match(/export const programQuery='([^']+)'/)![1];
it('keeps the shipped program setup SQL count fixed as tokens grow', async () => {
  const counts: number[] = [];
  for (const size of [2, 10]) {
    const statements: string[] = [], client = new Database(':memory:', { verbose: value => statements.push(String(value)) });
    clean.push(() => client.close());
    const clock = new FakeClock(), at = new Date(clock.now()).toISOString(), db = createDataSchema(client, () => new Date(clock.now()).toISOString());
    db.insert(members).values([{id:'owner', role:'owner', joinedAt:at}, {id:'sam', role:'member', joinedAt:at}]).run();
    const raw = 'o'.repeat(64);
    db.insert(tokens).values({fingerprint:createHash('sha256').update(raw).digest('hex'),kind:'owner',member:'owner',label:'Owner',createdAt:at}).run();
    const root = sharedRoot({db,clock,originAllowed:()=>true,reportError:()=>{}}); clean.push(() => root.close());
    for (let n = 0; n < size; n++) root.services.programSetup!.issue({member:'sam',label:`Program ${n}`,records:n===0?[]:['tasks'],operations:n===0?[]:['tasks.command']});
    statements.length = 0;
    const response = await root.http.request('/graphql',{method:'POST',headers:{authorization:`Bearer ${raw}`,'content-type':'application/json'},body:JSON.stringify({query})});
    const result = await response.json();
    expect(response.status).toBe(200); expect(result.errors).toBeUndefined(); expect(result.data.programSetup.tokens).toHaveLength(size);
    expect(result.data.programSetup.tokens.find((row:{label:string})=>row.label==='Program 0')).toMatchObject({records:[],operations:[]});
    expect(JSON.stringify(result)).not.toContain(raw);
    counts.push(statements.filter(statement => /^\s*(select|with)\b/i.test(statement)).length);
  }
  expect(counts).toEqual([counts[0],counts[0]]);
});
