import {execFileSync} from 'node:child_process';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect, it} from 'vitest';
import {PeopleStore} from '../src/backends/people.js';

it('requires the exact current matches, applies the list atomically and can revoke after a conflict', () => {
  const home = mkdtempSync(join(tmpdir(), 'recipient-display-'));
  const path = join(home, 'people.db'), matches = join(home, 'matches.json');
  const store = new PeopleStore({dbPath:path});
  try {
    const rows = ['U00000001','U00000002'].map(account => ['TWORK',account,'sam']);
    store.write({slug:'sam',name:'Sam',where:{slack:{value:rows.map(row=>row[1])}}});
    const insert = store.database.prepare('INSERT INTO person_sighting_aliases (workspace,account,slug) VALUES (?,?,?)');
    for (const row of rows) insert.run(...row);
    const enabled = () => store.database.prepare('SELECT count(*) AS n FROM person_sighting_aliases WHERE recipient_display_slug=slug').get();
    const run = (...args:string[]) => JSON.parse(execFileSync(process.execPath,
      ['--import','tsx',join(import.meta.dirname,'slack-recipient-display.ts'),path,matches,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}));
    writeFileSync(matches,JSON.stringify([rows[0],['TWORK',rows[1][1],'changed']]));
    expect(()=>run('enable','--apply')).toThrow();
    expect(enabled()).toEqual({n:0});
    writeFileSync(matches,JSON.stringify(rows));
    expect(run('enable')).toEqual({accounts:2,changed:2,applied:false});
    expect(enabled()).toEqual({n:0});
    expect(run('enable','--apply').changed).toBe(2);
    expect(run('enable','--apply').changed).toBe(0);
    store.write({slug:'alex',name:'Alex',where:{slack:{value:rows[1][1]}}});
    expect(()=>run('enable','--apply')).toThrow();
    expect(run('disable','--apply').changed).toBe(2);
    expect(enabled()).toEqual({n:0});
  } finally {store.close();rmSync(home,{recursive:true,force:true});}
});
