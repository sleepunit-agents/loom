import {afterEach,expect,it,vi} from 'vitest';
const browser=vi.hoisted(()=>({launch:vi.fn(),executablePath:()=>'/not-a-browser'}));
vi.mock('playwright-core',()=>({chromium:browser}));
afterEach(()=>{vi.unstubAllEnvs();});
it('rejects the actual opted-in self-hosted Activity evidence module before any browser launch',async()=>{
 vi.stubEnv('CI','1');vi.stubEnv('LOOM_ACTIVITY_EVIDENCE','1');vi.stubEnv('RUNNER_ENVIRONMENT','self-hosted');
 await expect(import('./mind-activity-app.integration.test.js')).rejects.toThrow('Activity browser evidence requires a hosted runner');
 expect(browser.launch).not.toHaveBeenCalled();
});
