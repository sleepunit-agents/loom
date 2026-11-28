import { describe, expect, it } from 'vitest';
import { afterSignin, gateFor } from './gate-address';

describe('the gate and the boards page hand a visitor to each other', () => {
  it('sends a signed-out visitor to the gate with the boards address to come back to', () => {
    expect(gateFor('/app/t/th%3Asam')).toBe('/?to=' + encodeURIComponent('/app/t/th%3Asam'));
    expect(gateFor('/app/b/bd-1')).toBe('/?to=%2Fapp%2Fb%2Fbd-1');
    expect(gateFor('/app/boards')).toBe('/');
    expect(gateFor('/somewhere/else')).toBe('/');
  });
  it('goes on to that boards address once signed in, and never to anywhere else', () => {
    expect(afterSignin('/', '?to=' + encodeURIComponent('/app/t/th%3Asam'))).toBe('/app/t/th%3Asam');
    expect(afterSignin('/', '?to=%2Fapp%2Fb%2Fbd-1')).toBe('/app/b/bd-1');
    for (const to of ['https://evil.example/app/boards', '//evil.example/app/boards', '/app/t/a/b', '/p/inbox-preview', 'javascript:alert(1)'])
      expect(afterSignin('/', '?to=' + encodeURIComponent(to))).toBe('/app/boards');
  });
  it('takes the desktop\'s address for a thread to that thread on the boards page', () => {
    expect(afterSignin('/p/comms-preview/thread/sam', '')).toBe('/app/t/th%3Asam');
    expect(afterSignin('/p/comms-preview/thread/work-abc', '')).toBe('/app/t/th%3Awork-abc');
    expect(afterSignin('/p/comms-preview/thread/%E0%A4%A', '')).toBe('/app/boards');
  });
  it('takes the root and every other desktop address to the boards page\'s home', () => {
    for (const path of ['/', '/p/inbox-preview', '/p/work/backlog/task/t-1', '/p/comms-preview/conversation/cv-1', '/p/tempo'])
      expect(afterSignin(path, '')).toBe('/app/boards');
  });
});
