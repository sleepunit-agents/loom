/** The required check must include the built-browser result on next. */
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
export interface CiResults {test?:string;package?:string;walkthrough?:string;required?:boolean}
export function ciPassed(results:CiResults):boolean{
 if(typeof results.required!=='boolean')return false;
 return results.test==='success'&&results.package==='success'&&(results.walkthrough==='success'||!results.required&&results.walkthrough==='skipped');
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const flag=process.env.REBUILD_REQUIRED,required=flag==='true'?true:flag==='false'?false:undefined;
 if(!ciPassed({test:process.env.TEST_RESULT,package:process.env.PACKAGE_RESULT,walkthrough:process.env.WALKTHROUGH_RESULT,required})){
  console.error('Required CI jobs did not all pass.');process.exitCode=1;
 }
}
