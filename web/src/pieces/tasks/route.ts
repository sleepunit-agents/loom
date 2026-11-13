/** A marker prevents URL normalization of imported '.' and '..' task ids. */
export const taskSegment=(id:string)=>`~${encodeURIComponent(id)}`;
export function taskId(path:string):string|undefined {
 const raw=/\/task\/([^/]+)$/.exec(path)?.[1];if(!raw)return;
 try {return decodeURIComponent(raw.startsWith('~')?raw.slice(1):raw)||undefined;}catch{return;}
}
