import {expect,it} from 'vitest';
import {signinDoorEvidence} from './rebuild-signin-door.mjs';
it('proves the actual isolated sign-in door and returns only completed boolean evidence',async()=>{
 const result=await signinDoorEvidence();expect(result.ok,result.error).toBe(true);expect(result).toMatchObject({ok:true,checks:{trustedServiceWithoutToken:true,unauthenticatedDenied:true,memberAgentMachineAuthenticated:true,memberIdentityBound:true,nonownerIssuanceDenied:true,oneUseLink:true,expiredLinkDenied:true,sixHourAutomatedSession:true,personSessionRetained:true,personalMetadataOnly:true,ownerHouseholdList:true,ownerSessionRevocation:true,ownerTokenRevocation:true,tokenCookieLinkFingerprints:true,rawSecretsNeverPersisted:true,closed:true}});
 expect(Object.values(result.checks).every(value=>value===true)).toBe(true);expect(JSON.stringify(result)).not.toContain('loom_');
});
