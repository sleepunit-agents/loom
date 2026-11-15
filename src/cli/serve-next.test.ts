import {expect,it} from 'vitest';
import {Readable} from 'node:stream';
import {run} from './serve.js';

// The normal configured listener is exercised by shared-startup.test.ts.
// Retired startup flags must never select the old daemon implicitly.
it.each([
 ['--next','--staging'],
 ['--http','--secret-holder','/fictional/holder'],
 ['--next','--secret-authority','/fictional/authority'],
 ['--http','--secret-writes','/fictional/writes'],
])('refuses retired shared startup options: %j',async(...args)=>{
 const errors:string[]=[];
 expect(await run(args,{stdin:Readable.from([]),stdinIsTTY:false,env:{},stdout(){},stderr:text=>errors.push(text)})).toBe(2);
 expect(errors.join('')).toContain('legacy startup options are retired');
});
