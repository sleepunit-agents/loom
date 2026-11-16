/** The browser producer records its own execution context after cleanup.
 * A standalone producer may emit unbound diagnostic proof; the walkthrough
 * consumer accepts only its matching nonce and source tuple. */
import {writeFileSync} from 'node:fs';
export function accountProofContext(environment=process.env){return{version:1,producer:'account-next',execution:environment.LOOM_WALKTHROUGH_EVIDENCE_RUN??null,source:{commit:environment.GITHUB_SHA??null,run:environment.GITHUB_RUN_ID??null,attempt:environment.GITHUB_RUN_ATTEMPT??null}};}
export function accountProof(facts,environment=process.env){
 if(!facts||facts.completed!==true||Object.entries(facts).some(([key,value])=>!/^\w+$/.test(key)||typeof value!=='boolean'))throw Error('Account proof facts must be completed booleans');
 return{...facts,_evidence:accountProofContext(environment)};
}
export function writeAccountProof(file,facts){writeFileSync(file,JSON.stringify(accountProof(facts),null,2)+'\n',{mode:0o600});}
