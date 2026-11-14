/** A marker prevents URL normalization of imported '.' and '..' task ids.
 * ~: carries raw UTF-16 for empty or malformed legacy ids; ':' is otherwise
 * percent-encoded, so it cannot collide with an existing canonical segment.
 */
export function taskSegment(id:string):string {
 if(/^t-\d+$/.test(id))return id;
 if(id)try{return `~${encodeURIComponent(id)}`;}catch{/* valid legacy string outside URI's scalar domain */}
 return '~:'+Array.from({length:id.length},(_,n)=>id.charCodeAt(n).toString(16).padStart(4,'0')).join('');
}
export function taskId(path:string):string|undefined {
 const raw=/\/task\/([^/]+)$/.exec(path)?.[1];if(!raw)return;
 if(raw.startsWith('~:')) {
  const units=raw.slice(2);if(!/^(?:[0-9a-f]{4})*$/.test(units))return;
  return units.match(/.{4}/g)?.map(unit=>String.fromCharCode(parseInt(unit,16))).join('')??'';
 }
 try {return decodeURIComponent(raw.startsWith('~')?raw.slice(1):raw)||undefined;}catch{return;}
}
