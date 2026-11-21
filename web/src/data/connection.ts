/** Brief outages recover quickly. Long outages keep probing at least once every 16 seconds. */
export function reconnectDelay(attempt:number):number {
  return Math.min(15_000,500*2**Math.min(attempt,5))+Math.random()*500;
}

/** A socket failure cannot distinguish a server outage from an expired browser cookie. */
export const checkSessionEvent='loom-check-session';

let member:string|null=null;
export function setDeskMember(id:string|null){member=id;}
export function deskConnectionParams(){return member===null?{}:{expectedMember:member};}
