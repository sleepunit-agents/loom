import {memberOperation} from '../data/operation';
/** Revocation can commit and then lose authority before its response. Confirm
 * current browser identity without treating a refused write as success. */
export async function sessionChange(name:string,input:object):Promise<'signed-out'|'saved'>{
 let failure:unknown,failed=false;
 try{await memberOperation(name,input);}catch(error){failure=error;failed=true;}
 const response=await fetch('/auth/session',{credentials:'same-origin',cache:'no-store',redirect:'error'});
 if(!response.ok)throw Error('Could not check your sign-in');
 const session:unknown=await response.json();
 if(!session||typeof session!=='object'||!('viewer'in session))throw Error('Could not check your sign-in');
 if(session.viewer===null){location.reload();return 'signed-out';}
 if(!session.viewer||typeof session.viewer!=='object'||!('id'in session.viewer)||typeof session.viewer.id!=='string')throw Error('Could not check your sign-in');
 if(failed)throw failure;
 return 'saved';
}
