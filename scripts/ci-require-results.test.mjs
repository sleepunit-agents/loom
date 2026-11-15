import {it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {failedResults} from './ci-require-results.mjs';
const events=[
 {name:'next PR',GITHUB_BASE_REF:'next',GITHUB_REF:'refs/pull/1/merge',browser:true},
 {name:'next push',GITHUB_BASE_REF:'',GITHUB_REF:'refs/heads/next',browser:true},
 {name:'main PR',GITHUB_BASE_REF:'main',GITHUB_REF:'refs/pull/2/merge',browser:false},
 {name:'main push',GITHUB_BASE_REF:'',GITHUB_REF:'refs/heads/main',browser:false},
 {name:'merge group',GITHUB_BASE_REF:'',GITHUB_REF:'refs/heads/gh-readonly-queue/main/group',browser:false},
];
for(const event of events)it(`${event.name} rejects every unsuccessful required dependency`,()=>{
 for(const RESULT of ['success','failure','cancelled','skipped',undefined])
 for(const PACKAGE of ['success','failure','cancelled','skipped',undefined])
 for(const WALKTHROUGH of ['success','failure','cancelled','skipped',undefined]){
  const failed=failedResults({...event,RESULT,PACKAGE,WALKTHROUGH});
  expect(failed.length===0,JSON.stringify({event,RESULT,PACKAGE,WALKTHROUGH})).toBe(RESULT==='success'&&PACKAGE==='success'&&(!event.browser||WALKTHROUGH==='success'));
 }
});
it('wires the real hosted walkthrough into the required aggregate without a second automatic run',()=>{
 const ci=readFileSync(new URL('../.github/workflows/ci.yml',import.meta.url),'utf8');
 const browser=readFileSync(new URL('../.github/workflows/rebuild-walkthrough.yml',import.meta.url),'utf8');
 expect(ci).toContain("if: github.base_ref == 'next' || github.ref == 'refs/heads/next'\n    uses: ./.github/workflows/rebuild-walkthrough.yml");
 expect(ci).toContain('needs: [test, package, walkthrough]');
 expect(ci).toContain('WALKTHROUGH: ${{ needs.walkthrough.result }}');
 expect(ci).toContain('RESULT: ${{ needs.test.result }}');expect(ci).toContain('PACKAGE: ${{ needs.package.result }}');
 expect(ci).toContain('run: node scripts/ci-require-results.mjs');
 expect(browser).toContain('  workflow_call:');expect(browser).toContain('  workflow_dispatch:');
 expect(browser).not.toMatch(/^  (pull_request|push):/m);
 expect(browser).toContain('group: rebuild-walkthrough-${{ github.workflow }}-');
 expect(browser).toContain('runs-on: ubuntu-latest');expect(browser).toContain('if: always()');
 expect(browser).toContain('LOOM_TEST_CHROME=');expect(browser).toContain('src/ui/rebuild-walkthrough.integration.test.ts');
});
