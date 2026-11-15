/** Ordinary evidence errors retain useful context, never the virtual key. */
export function accountEvidenceError(error:unknown,key:string):Error{
 let message=String(error).replace(/\/login\/[a-zA-Z0-9_-]+/g,'/login/[redacted]');
 if(key)for(const form of new Set([key,encodeURIComponent(key),key.replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')]))message=message.replaceAll(form,'[virtual key redacted]');
 return Error(message);
}
