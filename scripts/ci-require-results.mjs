/** Fail closed on every dependency; a skipped browser is acceptable only off next. */
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
export function failedResults(env){
 const required={test:env.RESULT,package:env.PACKAGE};
 if(env.GITHUB_BASE_REF==='next'||env.GITHUB_REF==='refs/heads/next')required.walkthrough=env.WALKTHROUGH;
 return Object.entries(required).filter(([,result])=>result!=='success').map(([job,result])=>`${job}: ${result??'missing result'}`);
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const failed=failedResults(process.env);
 if(failed.length){console.error('Required CI jobs did not succeed: '+failed.join(', '));process.exitCode=1;}
}
