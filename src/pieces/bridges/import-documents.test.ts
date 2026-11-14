import {afterEach,expect,it} from 'vitest';
import {mkdtempSync,writeFileSync,rmSync,symlinkSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {readBridgeDocuments} from './import-documents.js';
const roots:string[]=[];afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function fixture(){const root=mkdtempSync(join(tmpdir(),'bridge-documents-'));roots.push(root);const path=join(root,'document');return {root,path,name:'bridges-documents/0.md'};}
it('preserves exact UTF-8 including BOM, line endings and checksum',()=>{
 const f=fixture(),bytes=Buffer.from('\uFEFFprivate\r\n🐟$slot\n');writeFileSync(f.path,bytes);
 expect(readBridgeDocuments([f])).toEqual([{name:f.name,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),content:bytes.toString('utf8')}]);
});
it('refuses unsafe names, duplicates, missing files, links, directories, invalid UTF-8 and oversized input without source words',()=>{
 const f=fixture();writeFileSync(f.path,'PRIVATE');
 for(const name of ['../secret','/secret','bridges-documents/../0.md','other.md'])expect(()=>readBridgeDocuments([{...f,name}])).toThrow('Invalid offline Bridges selected documents');
 expect(()=>readBridgeDocuments([f,f])).toThrow();
 expect(()=>readBridgeDocuments([{...f,path:join(f.root,'missing')}])).toThrow('Invalid offline Bridges selected documents');
 const link=join(f.root,'link');symlinkSync(f.path,link);expect(()=>readBridgeDocuments([{...f,path:link}])).toThrow();
 const directory=join(f.root,'directory');mkdirSync(directory);expect(()=>readBridgeDocuments([{...f,path:directory}])).toThrow();
 writeFileSync(f.path,Buffer.from([0xff]));expect(()=>readBridgeDocuments([f])).toThrow();
 writeFileSync(f.path,Buffer.alloc(1024*1024+1));expect(()=>readBridgeDocuments([f])).toThrow();
 for(let i=0;i<129;i++)writeFileSync(join(f.root,`${i}.md`),'a');
 expect(()=>readBridgeDocuments(Array.from({length:129},(_,i)=>({...f,name:`bridges-documents/${i}.md`,path:join(f.root,`${i}.md`)})))).toThrow();
});
it('accepts exactly 8 MiB total and refuses one extra selected byte',()=>{
 const f=fixture(),files=Array.from({length:9},(_,i)=>({name:`bridges-documents/${i}.md`,path:join(f.root,`${i}.md`)}));
 for(const file of files.slice(0,8))writeFileSync(file.path,'a'.repeat(1024*1024));
 expect(readBridgeDocuments(files.slice(0,8))).toHaveLength(8);
 writeFileSync(files[8].path,'a');expect(()=>readBridgeDocuments(files)).toThrow('Invalid offline Bridges selected documents');
});
