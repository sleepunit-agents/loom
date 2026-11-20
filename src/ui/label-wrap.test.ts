import {readdirSync,readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {expect,it} from 'vitest';

it('keeps human-readable labels in the app and walkthrough site free of ellipses',()=>{
  const root=fileURLToPath(new URL('../../',import.meta.url));
  const files=readdirSync(join(root,'web/src'),{recursive:true,encoding:'utf8'})
    .filter(file=>/\.(css|tsx)$/.test(file)&&!file.includes('.test.'))
    .map(file=>join('web/src',file));
  files.push('docs/how-it-works/site/site.css');
  const exceptions=new Map([
    ['web/src/looks/looks.css',':root[data-look] .loom-tick__line'],
    ['docs/how-it-works/site/site.css','.desk__tick'],
  ]);
  const offending:string[]=[];
  for(const file of files){
    const source=readFileSync(join(root,file),'utf8');
    if(file.endsWith('.css')){
      for(const rule of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)){
        const selector=rule[1].replace(/\/\*[\s\S]*?\*\//g,'').trim();
        if(/text-overflow\s*:\s*ellipsis/.test(rule[2])&&selector!==exceptions.get(file))offending.push(file+' '+selector);
      }
    }else if(/\b(?:truncate|line-clamp-\d+)\b/.test(source))offending.push(file);
  }
  expect(offending).toEqual([]);
});

it('routes native choices through the shared wrapping control', () => {
  const root = fileURLToPath(new URL('../../web/src/', import.meta.url));
  const bypasses = readdirSync(root, {recursive: true, encoding: 'utf8'})
    .filter(file => file.endsWith('.tsx') && !file.includes('.test.') && file !== 'kit/native-select.tsx')
    .filter(file => /<select\b/.test(readFileSync(join(root, file), 'utf8')));
  expect(bypasses).toEqual([]);
});
