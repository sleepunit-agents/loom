/** Typed write-time mentions shared by conversation producers. No storage or IO. */
import {TASK_ID} from '../../slug.js';
export function refsIn(text:string):string[] {
 const out=new Set<string>();
 const re=new RegExp(`(?<![\\w./-])([\\w.-]+)\\/([\\w.-]+)#(\\d{1,10})\\b|\\b(${TASK_ID})\\b|(?:^|\\s)note:([\\w./-]+)`,'g');
 for(let m;(m=re.exec(text));){
  if(m[3])out.add(`github:${m[1]}/${m[2]}#${m[3]}`);
  else if(m[4])out.add(m[4]);
  else {const path=m[5].replace(/[./]+$/,'');if(path&&!path.split('/').includes('..'))out.add(`note:${path}`);}
 }
 return [...out].filter(ref=>ref.length<=200);
}
