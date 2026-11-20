/** Text references only; bare repo#N has no owner on the new side. */
export type RefBit={ref?:string;text:string};
export function refBits(text:string):RefBit[]{
 const bits:RefBit[]=[];let at=0;
 // Forge first: an owner named t-12 must not become a task chip.
 const re=/(?<![\w./-])([\w.-]+)\/([\w.-]+)#([1-9][0-9]{0,9})\b|\b(t-\d{1,9})\b|\b(a-[0-9a-f]{8})\b|\b(cv-[0-9a-f]{12})\b|(?<![\w])note:([A-Za-z0-9][\w./-]{0,199})|\[\[([a-z0-9][a-z0-9-]{0,79})\]\]|\b(project|person|agent):([a-z0-9][a-z0-9-]{0,79})\b|(?<![\w@./-])@([a-z][a-z0-9-]{0,39})\b/g;
 for(let m;(m=re.exec(text));){
  let ref:string|undefined,words=m[0];
  if(m[3]){if(![m[1],m[2]].some(s=>s==='.'||s==='..'))ref=`github:${m[1]}/${m[2]}#${m[3]}`;}
  else if(m[4])ref=m[4];else if(m[5])ref=m[5];else if(m[6])ref=m[6];
  else if(m[7]){const p=m[7].replace(/[./]+$/,'');if(p&&!p.split('/').includes('..')){ref=`note:${p}`;words=`note:${p}`;}}
  else if(m[8])ref=`knowledge:${m[8]}`;
  else if(m[9])ref=`${m[9]}:${m[10]}`;else if(m[11])ref=`at:${m[11]}`;
  if(!ref||ref.length>200)continue;
  if(m.index>at)bits.push({text:text.slice(at,m.index)});
  bits.push({ref,text:words});at=m.index+words.length;re.lastIndex=at;
 }
 if(at<text.length)bits.push({text:text.slice(at)});return bits;
}
export function refBatches(refs:readonly string[],thread=''):string[][]{
 const once=[...new Set(refs.filter(r=>r.length>0&&r.length<=200))].sort(),out:string[][]=[];
 let part:string[]=[];
 for(const ref of once){if(part.length===60||JSON.stringify({thread,refs:[...part,ref]}).length>14000){if(part.length)out.push(part);part=[];}part.push(ref);}
 if(part.length)out.push(part);return out;
}
