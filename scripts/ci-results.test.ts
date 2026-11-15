import {expect,it} from 'vitest';
import {readFileSync} from 'node:fs';
import {ciPassed,type CiResults} from './ci-results.js';
const passing:CiResults={test:'success',package:'success',walkthrough:'success',required:true};
const ci=readFileSync(new URL('../.github/workflows/ci.yml',import.meta.url),'utf8'),browser=readFileSync(new URL('../.github/workflows/rebuild-walkthrough.yml',import.meta.url),'utf8');
it.each(['failure','cancelled','skipped',undefined])('a %s built walkthrough cannot pass next CI results',walkthrough=>{
 expect(ciPassed({...passing,walkthrough})).toBe(false);
});
it('requires tests and packaging, refuses missing scope/results, and preserves intentional non-next skips',()=>{
 expect(ciPassed(passing)).toBe(true);
 for(const field of ['test','package','required'])expect(ciPassed({...passing,[field]:undefined})).toBe(false);
 expect(ciPassed({...passing,test:'failure'})).toBe(false);expect(ciPassed({...passing,package:'cancelled'})).toBe(false);
 expect(ciPassed({...passing,required:false,walkthrough:'skipped'})).toBe(true);
 expect(ciPassed({...passing,required:false,walkthrough:'failure'})).toBe(false);
});
function block(text:string,header:string):string{
 const lines=text.split('\n'),start=lines.indexOf(header);if(start<0)throw Error('Workflow block missing: '+header);
 const depth=header.length-header.trimStart().length;let end=start+1;
 for(;end<lines.length;end++){if(!lines[end].trim()||lines[end].trimStart().startsWith('#'))continue;if(lines[end].length-lines[end].trimStart().length<=depth)break;}
 return lines.slice(start,end).join('\n');
}
it('wires the hosted browser into the required result with the exact next scope and no path filters',()=>{
 const scope="github.base_ref == 'next' || github.ref == 'refs/heads/next'",call=block(ci,'  walkthrough:'),results=block(ci,'  results:'),gate=block(ci,'      - name: Require every shard, deploy build and next walkthrough to pass');
 expect(results).toContain('needs: [test, package, walkthrough]');expect(call).toContain('uses: ./.github/workflows/rebuild-walkthrough.yml');expect(call).toContain('if: '+scope);
 expect(gate).toContain('WALKTHROUGH_RESULT: ${{ needs.walkthrough.result }}');expect(gate).toContain('REBUILD_REQUIRED: ${{ '+scope+' }}');expect(gate).toMatch(/^        run: node scripts\/ci-results.ts$/m);
 expect(browser).toContain('workflow_call:');expect(browser).toContain('runs-on: ubuntu-latest');
 for(const workflow of [ci,browser])expect(workflow).not.toMatch(/^\s+paths(?:-ignore)?:/m);
});
it('fails an empty or failed browser suite in the actual proof step, and names rerun artifacts separately',()=>{
 const proof=block(browser,'      - name: Sign in and visit every launcher app'),lines=proof.split('\n').map(line=>line.trim());
 const executable=lines.indexOf('test -x "$LOOM_TEST_CHROME"'),run=lines.indexOf('nice -n 19 npx vitest run src/ui/rebuild-walkthrough.integration.test.ts --maxWorkers=1'),report=lines.indexOf('test -s "$LOOM_TEST_SHOTS/report.json"');
 expect(executable).toBeGreaterThan(0);expect(run).toBeGreaterThan(executable);expect(report).toBeGreaterThan(run);expect(lines).toContain('set -euo pipefail');expect(proof).not.toMatch(/continue-on-error|^\s+if:/m);expect(browser).not.toMatch(/^\s*continue-on-error:/m);expect(block(ci,'  walkthrough:')).not.toMatch(/^\s*continue-on-error:/m);
 const upload=block(browser,'      - uses: actions/upload-artifact@v7');expect(upload).toContain('name: rebuild-walkthrough-${{ github.event.pull_request.head.sha || github.sha }}-${{ github.run_attempt }}');
});
function group(text:string,workflow:string,event:string,pull:number|undefined,ref:string):string{
 const template=/^concurrency:\n  group: (.*)$/m.exec(text)?.[1];if(!template)throw Error('No concurrency group');
 const values:Record<string,string>={
  'github.workflow':workflow,'github.event_name':event,
  'github.event.pull_request.number || github.ref':String(pull??ref),
  "github.event.pull_request.number || (github.event_name == 'push' && github.ref) || github.sha":String(pull??(event==='push'?ref:'fictional-sha')),
 };
 return template.replace(/\$\{\{\s*(.*?)\s*\}\}/g,(_match,key:string)=>{if(!(key in values))throw Error('Unreadable concurrency expression: '+key);return values[key];});
}
it.each([['pull_request',42,'refs/pull/42/merge'],['push',undefined,'refs/heads/next']] as const)('keeps parent, called and standalone cancellation groups separate for %s', (event,pull,ref)=>{
 const caller=/^name: (.*)$/m.exec(ci)![1],standalone=/^name: (.*)$/m.exec(browser)![1];
 const parent=group(ci,caller,event,pull,ref),called=group(browser,caller,event,pull,ref),direct=group(browser,standalone,event,pull,ref);
 expect(new Set([parent,called,direct]).size).toBe(3);
});
it('keeps every workflow permission block limited to read-only contents, including job overrides',()=>{
 for(const text of [ci,browser]){
  const lines=text.split('\n');let blocks=0,global=false;
  for(let i=0;i<lines.length;i++){
   if(!/^\s*["']?permissions["']?:/.test(lines[i]))continue;
   expect(lines[i].trim()).toBe('permissions:');blocks++;const depth=lines[i].length-lines[i].trimStart().length,children:string[]=[];if(depth===0)global=true;
   for(let j=i+1;j<lines.length;j++){
    const line=lines[j].replace(/\s+#.*$/,'');if(!line.trim())continue;
    if(line.length-line.trimStart().length<=depth)break;children.push(line.trim());
   }
   expect(children).toEqual(['contents: read']);
  }
  expect(blocks).toBeGreaterThan(0);expect(global).toBe(true);
 }
});
