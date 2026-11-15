import {expect,it} from 'vitest';
import {readFileSync} from 'node:fs';
import {ciPassed} from './check-ci-results.mjs';
const passing={test:'success',build:'success',walkthrough:'success',required:'true'};
it.each(['failure','cancelled','skipped',undefined])('a %s built walkthrough cannot pass next CI results',walkthrough=>{
 expect(ciPassed({...passing,walkthrough})).toBe(false);
});
it('still requires tests and packaging, and refuses missing scope or result metadata',()=>{
 expect(ciPassed(passing)).toBe(true);
 for(const field of ['test','build','required'])expect(ciPassed({...passing,[field]:undefined})).toBe(false);
 expect(ciPassed({...passing,test:'failure'})).toBe(false);expect(ciPassed({...passing,build:'cancelled'})).toBe(false);
 expect(ciPassed({...passing,required:'false',walkthrough:'skipped'})).toBe(true);
 expect(ciPassed({...passing,required:'false',walkthrough:'failure'})).toBe(false);
});
it('wires the actual hosted browser workflow into the existing required check without path skips',()=>{
 const ci=readFileSync(new URL('../.github/workflows/ci.yml',import.meta.url),'utf8'),browser=readFileSync(new URL('../.github/workflows/rebuild-walkthrough.yml',import.meta.url),'utf8');
 expect(ci).toContain('needs: [test, package, walkthrough]');
 expect(ci).toContain('uses: ./.github/workflows/rebuild-walkthrough.yml');
 expect(ci).toContain('WALKTHROUGH: ${{ needs.walkthrough.result }}');expect(ci).toContain('REBUILD_REQUIRED: ${{ github.base_ref');
 expect(ci).toContain('run: node scripts/check-ci-results.mjs');
 expect(browser).toContain('workflow_call:');expect(browser).toContain('runs-on: ubuntu-latest');expect(browser).not.toContain('    paths:');expect(browser).toContain('test -s "$LOOM_TEST_SHOTS/report.json"');
});
