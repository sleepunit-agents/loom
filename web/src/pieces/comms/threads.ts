/** Keep direct-link selection separate from folder membership: a send can promote
 * an open background thread while its reader remains mounted. */
export function folderThreads<T extends {id:string;archived:number|null;pinned:boolean;unread:boolean;last:number;background?:unknown}>(records:readonly T[],folder:string):T[]{
 const rank=(t:T)=>t.pinned?0:t.unread?1:2;
 return records.filter(t=>folder==='archived'?t.archived!==null:t.archived===null&&(folder==='background'?t.background===true:t.background!==true))
  .sort((a,b)=>rank(a)-rank(b)||b.last-a.last||a.id.localeCompare(b.id));
}

/** Join in is local to the keyed reader. Only a member message persists promotion. */
export function watchingJob(job:false|{joined:boolean}|undefined,joining:boolean):boolean{
 return !!job&&!job.joined&&!joining;
}
