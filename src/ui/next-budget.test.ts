import { it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
const root=resolve(import.meta.dirname,'../../dist/web');
// The sign-in gate (next.html), the page loom serves at the root and at every address that is not the boards page's.
it.runIf(existsSync(resolve(root,'next.html')))('the sign-in gate stays inside first-page budgets',()=>{
 for(const page of ['next.html']){
  const html=readFileSync(resolve(root,page),'utf8');
  const sizes=(extension:string)=>[...html.matchAll(/(?:src|href)="\/app\/([^"]+)"/g)].filter(m=>m[1].endsWith('.'+extension)).reduce((n,m)=>n+gzipSync(readFileSync(resolve(root,m[1]))).length,0);
  expect(sizes('js')).toBeGreaterThan(0);expect(sizes('js')).toBeLessThan(250_000);
  expect(sizes('css')).toBeGreaterThan(0);expect(sizes('css')).toBeLessThan(120_000);
 }
});
