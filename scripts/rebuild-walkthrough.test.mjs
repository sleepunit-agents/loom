import {it,expect} from 'vitest';
import {redact,safeReport,localRequest} from './rebuild-walkthrough.mjs';
it('removes a one-time link from Playwright failure text, console errors and nested artifacts',()=>{
 const link='http://127.0.0.1:1234/login/fictional-secret';
 const error=`page.goto: net::ERR_ABORTED at ${link}\nCall log:\n - navigating to "${link}"`;
 const report=safeReport({fatal:error,apps:[{consoleErrors:[`Bearer fictional-token loom_ui=fictional-cookie;`]}]});
 expect(JSON.stringify(report)).not.toContain('fictional-secret');
 expect(JSON.stringify(report)).not.toContain('fictional-token');
 expect(JSON.stringify(report)).not.toContain('fictional-cookie');
 expect(redact('AGE-SECRET-KEY-FICTIONAL')).not.toContain('AGE-SECRET-KEY-');
});
it('permits only the started listener, with its exact port, for network requests',()=>{
 const origin='http://127.0.0.1:1234';
 expect(localRequest(origin+'/graphql',origin)).toBe(true);
 for(const url of ['https://github.com/example/repo','http://127.0.0.1:8787/graphql','http://127.0.0.1:1234.example.org','https://127.0.0.1:1234','garbage'])expect(localRequest(url,origin)).toBe(false);
});
