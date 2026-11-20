import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFoundation } from '../foundation.js';
import { importHousehold } from './household-importer.js';
import { storedSprite } from '../core/household/sprites.js';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=', 'base64');
const manifest = { cell: [1,1], states: { idle: { south: [{row:0,frames:1,weight:1}] } } };
const cleanup: (()=>void)[]=[];
afterEach(()=>{for(const f of cleanup.splice(0).reverse())f();});
function setup() {
 const root=mkdtempSync(join(tmpdir(),'sprites-')), from=join(root,'old'), home=join(root,'new');
 mkdirSync(join(from,'faces/art'),{recursive:true});
 writeFileSync(join(from,'household.json'),JSON.stringify({v:1,agents:['art'],default:'art',owner:'owner'}));
 writeFileSync(join(from,'faces/art/manifest.json'),JSON.stringify({...manifest,scale:1},null,2)+'\n');
 writeFileSync(join(from,'faces/art/sheet.png'),png);
 const app=createFoundation({home});cleanup.push(()=>rmSync(root,{recursive:true,force:true}),()=>app.close());
 return {app,from,home};
}
it('imports exact sheet bytes transactionally, retries, and refuses changed source artwork',()=>{
 const {app,from,home}=setup();
 expect(()=>importHousehold(app.db,home,from,1,{interrupt(){throw Error('power loss');}})).toThrow('power loss');
 expect(app.db.prepare("SELECT name FROM sqlite_master WHERE name='household_settings'").get()).toBeUndefined();
 expect(importHousehold(app.db,home,from,2).imported).toBe(true);
 const sprite=storedSprite(app.db,'art')!;
 expect(Buffer.from(sprite.rawManifest,'base64')).toEqual(readFileSync(join(from,'faces/art/manifest.json')));
 expect(sprite.manifest).toEqual(manifest);expect(Buffer.from(sprite.sheets['sheet.png'],'base64')).toEqual(png);
 expect(readFileSync(join(from,'faces/art/sheet.png'))).toEqual(png);
 expect(importHousehold(app.db,home,from,3).imported).toBe(false);
 writeFileSync(join(from,'faces/art/manifest.json'),JSON.stringify({...manifest,scale:0.5}));
 expect(()=>importHousehold(app.db,home,from,4)).toThrow('source changed');
 expect(storedSprite(app.db,'art')).toEqual(sprite);
});
it('refuses missing, escaping, oversized and out-of-sheet source assets before writing',()=>{
 const {app,from,home}=setup(), path=join(from,'faces/art/sheet.png');
 rmSync(path);expect(()=>importHousehold(app.db,home,from,1)).toThrow();
 symlinkSync('/etc/hostname',path);expect(()=>importHousehold(app.db,home,from,1)).toThrow('regular file');rmSync(path);
 writeFileSync(path,Buffer.alloc(4*1024*1024+1));expect(()=>importHousehold(app.db,home,from,1)).toThrow('regular file');
 writeFileSync(path,png);writeFileSync(join(from,'faces/art/manifest.json'),JSON.stringify({...manifest,cell:[2,2]}));
 expect(()=>importHousehold(app.db,home,from,1)).toThrow('dimensions');
 expect(app.db.prepare("SELECT name FROM sqlite_master WHERE name='household_settings'").get()).toBeUndefined();
});
