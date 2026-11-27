/** A one-time link that signs another device in as the current member: the request and its words, which the
 * desktop's DeviceLink and the boards page's `account` brick share. No component and no stylesheet. The link is a
 * credential: whoever calls this keeps it only while it is on screen, and never sends it anywhere. */
export const DEVICE_LINK_WORDS={
 about:(member?:string)=>`One sign-in within five minutes${member?` as ${member}`:''}. Anyone with the link can use it. The other device is signed in for as long as this one, and can add a passkey only within ten minutes of this browser's own sign-in.`,
 again:'Sign in again before making a sign-in link.',
 lost:'The link could not be shown. It was not retried; any unseen link expires within five minutes.',
};
/** Asks once, never again on its own. The link's path; 'signin' when a fresh sign-in is needed first; throws (with
 * nothing of the server's in it) when the reply was lost or was not a link. */
export async function requestSigninLink():Promise<{path:string}|'signin'>{
 const response=await fetch('/api/signin/link',{method:'POST',credentials:'same-origin',redirect:'error',headers:{'content-type':'application/json'},body:'{}',signal:AbortSignal.timeout(10000)});
 if(response.status===401||response.status===403)return 'signin';
 const result:unknown=await response.json();
 if(!response.ok||!result||typeof result!=='object'||!('ok'in result)||result.ok!==true||!('value'in result)||!result.value||typeof result.value!=='object'||!('path'in result.value)||typeof result.value.path!=='string'||!/^\/login\/[a-f0-9]{64}$/.test(result.value.path))throw Error();
 return {path:result.value.path};
}
