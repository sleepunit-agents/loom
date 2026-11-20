/** Sanitize decoded strings before normalization or serialization can hide a credential. */
export function parseRedactedJSON(text:string,token:string):unknown {
 return JSON.parse(text,(_key,value:unknown)=>typeof value==='string'?value.split(token).join('[redacted]').replace(/(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)/g,'[redacted]'):value);
}
