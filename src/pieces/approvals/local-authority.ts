/** Trusted runtime Caller proof is passed only through direct piece roles.
 * Services retain their own Viewer; this tests the member's current authority,
 * never grants private record access to a service or an agent token.
 */
import { mayAct, mayCreate, type Sharing } from '../../core/index.js';
import { serviceOf, type Caller } from './model.js';
export function localOwner(c:Caller,s:Sharing):boolean {
 if(c.for!=='owner')return false;
 if(c.member===undefined)return !c.people?.length;
 return !!c.conversation && c.people?.length===1 && c.people[0]===c.member
  && mayAct({kind:'member',id:c.member},{type:'approval',member:c.member,agent:c.who.agent,project:c.project},s,'household')
  && mayCreate({kind:'member',id:c.member},{type:'approval',member:c.member,agent:c.who.agent,project:c.project},s);
}
export function sameLocalCaller(a:Caller,b:Caller):boolean {
 return a.for==='owner' && b.for==='owner' && a.member===b.member && a.project===b.project
  && JSON.stringify(a.people??[])===JSON.stringify(b.people??[])
  && (a.member===undefined || a.conversation===b.conversation)
  && a.who.agent===b.who.agent && serviceOf(a.who)===serviceOf(b.who);
}
