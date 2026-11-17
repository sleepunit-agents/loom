import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createDataSchema, dataDatabase, dataSchemaNumber } from './database.js';
import { members } from './schema.js';

it('applies the supported initial schema once and retains its migration receipt across restart', () => {
  const directory=mkdtempSync(join(tmpdir(),'loom-schema-restart-'));
  const path=join(directory,'fictional.db'), at='2026-11-15T00:00:00.000Z';
  // A fresh database is marked with every schema number at once.
  const marks=Array.from({length:dataSchemaNumber},(_,index)=>({number:index+1,applied_at:at}));
  let client: Database.Database|undefined;
  try {
    client=new Database(path);
    const db=createDataSchema(client,()=>at);
    db.insert(members).values({id:'fictional',role:'owner',joinedAt:at}).run();
    const shape=client.prepare("SELECT type,name,sql FROM sqlite_schema ORDER BY type,name").all();
    client.close();
    client=new Database(path);
    // This is the normal prepared-home restart path, not a second install.
    const reopened=dataDatabase(client,()=> '2026-11-16T00:00:00.000Z');
    expect(reopened.query.members.findMany().sync()).toMatchObject([{id:'fictional'}]);
    expect(client.prepare('SELECT * FROM migrations').all()).toEqual(marks);
    expect(client.prepare("SELECT type,name,sql FROM sqlite_schema ORDER BY type,name").all()).toEqual(shape);
    // Even an accidental attempt to install twice fails without replacing data
    // or silently re-applying a shape change under a new timestamp.
    expect(()=>createDataSchema(client!)).toThrow('requires an empty database');
    expect(client.prepare('SELECT * FROM migrations').all()).toEqual(marks);
    expect(reopened.query.members.findMany().sync()).toMatchObject([{id:'fictional'}]);
  } finally {
    if(client?.open)client.close();
    rmSync(directory,{recursive:true,force:true});
  }
});
