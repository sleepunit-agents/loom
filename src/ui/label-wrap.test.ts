import {readdirSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {expect,it} from 'vitest';

it('keeps the launcher, shell and app tiles free of local label ellipses',()=>{
  const root=new URL('../../web/src/',import.meta.url).pathname;
  const files=['launcher.css'];
  for(const directory of ['pieces','shell','kit']){
    for(const entry of readdirSync(join(root,directory),{recursive:true})){
      if(typeof entry==='string'&&/\.(css|tsx)$/.test(entry)&&!entry.includes('.test.'))files.push(join(directory,entry));
    }
  }
  const offending=files.filter(file=>/text-overflow\s*:\s*ellipsis|\btruncate\b/.test(readFileSync(join(root,file),'utf8')));
  expect(offending).toEqual([]);
});
