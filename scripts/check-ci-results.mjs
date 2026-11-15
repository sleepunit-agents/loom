/** The required check must include the built-browser result on next. */
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
export function ciPassed({test,build,walkthrough,required}){
 if(required!=='true'&&required!=='false')return false;
 return test==='success'&&build==='success'&&(walkthrough==='success'||required==='false'&&walkthrough==='skipped');
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 if(!ciPassed({test:process.env.RESULT,build:process.env.PACKAGE,walkthrough:process.env.WALKTHROUGH,required:process.env.REBUILD_REQUIRED})){
  console.error('Required CI jobs did not all pass.');process.exitCode=1;
 }
}
