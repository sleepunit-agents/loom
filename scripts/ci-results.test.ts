import {expect,it} from 'vitest';
import {readFileSync} from 'node:fs';
import {ciPassed,type CiResults} from './ci-results.js';
const passing:CiResults={test:'success',package:'success',walkthrough:'success',required:true};
const ci=readFileSync(new URL('../.github/workflows/ci.yml',import.meta.url),'utf8');
const browser=readFileSync(new URL('../.github/workflows/rebuild-walkthrough.yml',import.meta.url),'utf8');
it.each(['failure','cancelled','skipped',undefined])('a %s built walkthrough cannot pass next CI results',walkthrough=>{
 expect(ciPassed({...passing,walkthrough})).toBe(false);
});
it('requires tests and packaging, refuses missing scope/results, and preserves intentional non-next skips',()=>{
 expect(ciPassed(passing)).toBe(true);
 for(const field of ['test','package','required'])expect(ciPassed({...passing,[field]:undefined})).toBe(false);
 expect(ciPassed({...passing,test:'failure'})).toBe(false);
 expect(ciPassed({...passing,package:'cancelled'})).toBe(false);
 expect(ciPassed({...passing,required:false,walkthrough:'skipped'})).toBe(true);
 expect(ciPassed({...passing,required:false,walkthrough:'failure'})).toBe(false);
});
const indent=(line:string)=>line.length-line.trimStart().length;
function blockAt(lines:string[],start:number):string[]{
 let end=start+1;
 for(;end<lines.length;end++){
  if(!lines[end].trim()||lines[end].trimStart().startsWith('#'))continue;
  if(indent(lines[end])<=indent(lines[start]))break;
 }
 return lines.slice(start,end);
}
function block(text:string,header:string):string{
 const lines=text.split('\n'),start=lines.indexOf(header);
 if(start<0)throw Error('Workflow block missing: '+header);
 return blockAt(lines,start).join('\n');
}
it('wires the hosted browser into the required result with the exact next scope and no path filters',()=>{
 const scope="github.base_ref == 'next' || github.ref == 'refs/heads/next'";
 const call=block(ci,'  walkthrough:');
 const results=block(ci,'  results:');
 const gate=block(ci,'      - name: Require every shard, deploy build and next walkthrough to pass');
 expect(results).toContain('needs: [test, package, walkthrough]');
 expect(call).toContain('uses: ./.github/workflows/rebuild-walkthrough.yml');
 expect(call).toContain('if: '+scope);
 expect(gate).toContain('WALKTHROUGH_RESULT: ${{ needs.walkthrough.result }}');
 expect(gate).toContain('REBUILD_REQUIRED: ${{ '+scope+' }}');
 expect(gate).toMatch(/^        run: node scripts\/ci-results.ts$/m);
 expect(gate).not.toContain('continue-on-error');
 expect(browser).toContain('workflow_call:');
 expect(browser).toContain('runs-on: ubuntu-latest');
 for(const workflow of [ci,browser])expect(workflow).not.toMatch(/^\s+paths(?:-ignore)?:/m);
});
it('uses a fresh report and fails empty/failed suites in the actual proof step',()=>{
 const proof=block(browser,'      - name: Sign in and visit every launcher app');
 const lines=proof.split('\n').map(line=>line.trim());
 const executable=lines.indexOf('test -x "$LOOM_TEST_CHROME"');
 const fresh=lines.indexOf('test ! -e "$LOOM_TEST_SHOTS/report.json"');
 const run=lines.indexOf('nice -n 19 npx vitest run src/ui/rebuild-walkthrough.integration.test.ts --maxWorkers=1');
 const report=lines.indexOf('test -s "$LOOM_TEST_SHOTS/report.json"');
 expect(executable).toBeGreaterThan(0);
 expect(fresh).toBeGreaterThan(executable);
 expect(run).toBeGreaterThan(fresh);
 expect(report).toBeGreaterThan(run);
 expect(lines).toContain('set -euo pipefail');
 expect(proof).toContain('rebuild-walkthrough-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT');
 expect(proof).not.toMatch(/continue-on-error|^\s+if:/m);
 expect(browser).not.toMatch(/^\s*continue-on-error:/m);
 expect(block(ci,'  walkthrough:')).not.toMatch(/^\s*continue-on-error:/m);
 const upload=block(browser,'      - uses: actions/upload-artifact@v7');
 expect(upload).toContain('name: rebuild-walkthrough-${{ github.event.pull_request.head.sha || github.sha }}-${{ github.run_attempt }}');
 expect(upload).toContain('path: ${{ runner.temp }}/rebuild-walkthrough-${{ github.run_id }}-${{ github.run_attempt }}/');
});
it('leaves cancellation with the caller instead of taking a second reusable-workflow lock',()=>{
 expect(browser).not.toMatch(/^\s*concurrency:/m);
 expect(block(ci,'concurrency:')).toContain("cancel-in-progress: ${{ github.event_name == 'pull_request' }}");
});
it('keeps explicit global and job permissions limited to read-only contents',()=>{
 for(const text of [ci,browser]){
  const lines=text.split('\n');
  let global=false;
  for(let i=0;i<lines.length;i++){
   if(!/^\s*["']?permissions["']?:/.test(lines[i]))continue;
   expect(lines[i].trim()).toBe('permissions:');
   if(indent(lines[i])===0)global=true;
   const children=blockAt(lines,i).slice(1).filter(line=>!line.trimStart().startsWith('#')).map(line=>line.replace(/\s+#.*$/,'').trim()).filter(Boolean);
   expect(children).toEqual(['contents: read']);
  }
  expect(global).toBe(true);
 }
});
