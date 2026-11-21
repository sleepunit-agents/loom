import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { deletedThreadLookup } from './legacy-thread-id.js';

it('matches the original creator and requires one recorded parent for an old thread deletion', () => {
  const dir=mkdtempSync(join(tmpdir(),'legacy-thread-'));
  const path=join(dir,'memories.db');
  const writer=new Database(path);
  const source=new Database(path,{readonly:true});
  try {
    writer.exec(`CREATE TABLE conversations(id TEXT, agent TEXT, venue TEXT, place TEXT);
      INSERT INTO conversations VALUES
        ('cv-d19bd80169d4','fern','loom','th:ordinary'),
        ('cv-0b37adc83353','fern','spawn','fixture-job')`);
    const salt=Buffer.from(Array.from({length:32},(_,i)=>i));
    const reader=()=>deletedThreadLookup(()=>source,()=>salt);
    const lookup=reader();
    expect(lookup('fern','alex','th:ordinary')).toBe('cv-d19bd80169d4');
    expect(lookup('fern','alex','th:oi7jknf4hi')).toBe('cv-0b37adc83353');
    expect(lookup('fern','robin','th:oi7jknf4hi')).toBeUndefined();
    expect(lookup('moss','alex','th:oi7jknf4hi')).toBeUndefined();
    writer.prepare('INSERT INTO conversations VALUES (?,?,?,?)').run('cv-93552a2f3944','fern','loom','th:oi7jknf4hi');
    expect(reader()('fern','alex','th:oi7jknf4hi')).toBeUndefined();
  } finally {
    source.close();
    writer.close();
    rmSync(dir,{recursive:true,force:true});
  }
});
