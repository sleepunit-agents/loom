import { expect, it, vi } from 'vitest';
import { FakeClock } from '../../core/clock.js';
import { bridgePresenceApi } from './presence.js';

const channel = '300000000000000004';
function fixture() {
  const clock = new FakeClock();
  const request = vi.fn<typeof fetch>(async () => new Response(null, {status:204}));
  const api = bridgePresenceApi({clock, request, tokenSecret:'fixture', current:() => true,
    secrets:{withValue: async (_name, use) => use('fixture')}});
  return {clock,request,api};
}

it('leaves capacity for other Discord work during a burst and resumes next second', async () => {
  const {api,clock,request} = fixture();
  for (let i = 0; i < 20; i++) await api.typing(channel);
  expect(request).toHaveBeenCalledTimes(8);
  clock.advance(1000);
  await api.typing(channel);
  expect(request).toHaveBeenCalledTimes(9);
});

it('observes an exhausted bucket and a fractional JSON-only retry interval', async () => {
  const {api,clock,request} = fixture();
  request.mockResolvedValueOnce(new Response(null,{status:204,headers:{'X-RateLimit-Remaining':'0','X-RateLimit-Reset-After':'1.5'}}));
  await api.typing(channel);
  clock.advance(1499); await api.typing(channel);
  expect(request).toHaveBeenCalledTimes(1);
  clock.advance(1);
  request.mockResolvedValueOnce(Response.json({retry_after:2.5},{status:429}));
  await api.typing(channel);
  clock.advance(2499); await api.typing(channel);
  expect(request).toHaveBeenCalledTimes(2);
  clock.advance(1); await api.typing(channel);
  expect(request).toHaveBeenCalledTimes(3);
});

it('absorbs network errors inside credential use', async () => {
  const {api,request} = fixture();
  request.mockRejectedValueOnce(Error('socket hang up'));
  expect(await api.typing(channel)).toBe(false);
});

it('wakes deferred presence when its budget reopens between the regular heartbeats', async () => {
  const clock = new FakeClock();
  const resume = vi.fn(), request = vi.fn(async () => new Response(null, {status:204}));
  const api = bridgePresenceApi({clock, request, resume, current:() => true, tokenSecret:'fixture',
    secrets:{withValue:async (_name, use) => use('fixture')}});
  for (let n = 0; n < 10; n++) await api.typing(channel);
  clock.advance(999);
  expect(resume).not.toHaveBeenCalled();
  clock.advance(1);
  expect(resume).toHaveBeenCalledTimes(1);
  await api.typing(channel);
  expect(request).toHaveBeenCalledTimes(9);
});
