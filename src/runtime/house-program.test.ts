import { expect, it } from 'vitest';
import { parseProgramResult, programExecutable } from './house-program.js';

it('accepts a quiet observation and an explicit wake with state and post', () => {
  for (const value of [{ version: 1, wake: false }, { version: 1, wake: true, line: 'ready', payload: [0], state: null, post: { channel: 'news', text: 'ready' } }])
    expect(parseProgramResult(JSON.stringify(value))).toEqual(value);
});
it('refuses extra output, ambiguous types, secrets and excess bytes with a fixed error', () => {
  for (const text of ['{}', '{"version":1,"wake":"yes"}', '{"version":1,"wake":false}{}',
    '{"version":1,"wake":true,"state":{"x":"my-\\u0073ecret"}}',
    '{"version":1,"wake":false,"post":{"channel":"x","text":"Bearer privatevalue"}}',
    JSON.stringify({version:1,wake:false,state:Buffer.from('my-secret').toString('base64')}),
    JSON.stringify({version:1,wake:false,line:'€'.repeat(7000)})])
    expect(() => parseProgramResult(text, ['my-secret'])).toThrow('Invalid program result');
});
it('only selects a named executable from the built house', () => {
  expect(programExecutable('weekly-check')).toBe('/home/agent/repo/.loom/programs/weekly-check');
  for (const name of ['../x','a/b','-c','a\n']) expect(() => programExecutable(name)).toThrow();
});

it('bounds each JSON field, nesting and receipt lines independently of the stdout cap', () => {
  for (const extra of [{ line: 'two\nlines' }, { state: 'x'.repeat(8192) }, { payload: '€'.repeat(2800) }])
    expect(() => parseProgramResult(JSON.stringify({ version: 1, wake: false, ...extra }))).toThrow();
  expect(() => parseProgramResult('{"version":1,"wake":false,"payload":' + '['.repeat(1000) + '0' + ']'.repeat(1000) + '}')).toThrow();
});
