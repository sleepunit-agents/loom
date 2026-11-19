import { looksLikeCredential } from './fixed-program.js';
import {testProgramPin} from './pinned-program.fixture.js';
import { expect, it } from 'vitest';
import { parseProgramResult, houseProgramSchema } from './house-program.js';

it('accepts a quiet observation and an explicit wake with state and post', () => {
  for (const value of [{ version: 1, wake: false }, { version: 1, wake: true, line: 'ready', payload: [0], state: null, post: { channel: 'news', text: 'ready' } }])
    expect(parseProgramResult(JSON.stringify(value))).toEqual(value);
});
it('refuses extra output, ambiguous types, secrets and excess bytes with a fixed error', () => {
  for (const text of [
    ...['loom_' + 'A'.repeat(43), 'github_pat_' + 'a'.repeat(40)].map(line => JSON.stringify({version:1,wake:true,line})), '{}', '{"version":1,"wake":"yes"}', '{"version":1,"wake":false}{}',
    '{"version":1,"wake":true,"state":{"x":"my-\\u0073ecret"}}',
    '{"version":1,"wake":false,"post":{"channel":"x","text":"Bearer privatevalue"}}',
    JSON.stringify({version:1,wake:false,state:Buffer.from('my-secret').toString('base64')}),
    JSON.stringify({version:1,wake:false,line:'€'.repeat(7000)})])
    expect(() => parseProgramResult(text, ['my-secret'])).toThrow('Invalid program result');
});
it('requires an immutable executable, fixed arguments and named secret bindings for the clock', () => {
  const program = {...testProgramPin, name:'watch', args:['weekly'], secrets:{KIT_TOKEN:'token'}, timeoutMs:100};
  expect(houseProgramSchema.parse(program)).toEqual(program);
  for (const change of [{image:'latest'}, {commit:'main'}, {program:'../x'}, {program:'/bin/sh'},
    {args:[{parameter:'input'}]}, {secrets:['KIT_TOKEN']}, {secrets:{PYTHONPATH:'token'}}])
    expect(houseProgramSchema.safeParse({...program,...change}).success).toBe(false);
});

it('bounds each JSON field, nesting and receipt lines independently of the stdout cap', () => {
  for (const extra of [{ line: 'two\nlines' }, { state: 'x'.repeat(8192) }, { payload: '€'.repeat(2800) }])
    expect(() => parseProgramResult(JSON.stringify({ version: 1, wake: false, ...extra }))).toThrow();
  expect(() => parseProgramResult('{"version":1,"wake":false,"payload":' + '['.repeat(1000) + '0' + ']'.repeat(1000) + '}')).toThrow();
});

it('recognizes JSON-escaped credentials inside a text tool response', () => {
  expect(looksLikeCredential('details: {"value":"my-\\u0073ecret"}', ['my-secret'])).toBe(true);
});
