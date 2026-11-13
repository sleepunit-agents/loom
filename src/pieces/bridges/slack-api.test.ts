import { describe, expect, it, vi } from 'vitest';
import { slackApi } from './slack-api.js';
import type { Venue, Message } from './model.js';
const venue: Venue = { id:'v', platform:'slack', agent:'art', workspace:'T123', bot:'U999', tokenSecret:'slack-bot', enabled:true, only:[],ignore:[],botRoles:[] };
const message: Message = { id:'1', channel:'G123', user:'U111', text:'hello', mentions:[], dm:false,group:true };
const human = (id: string) => ({id, team_id:'T123', deleted:false,is_bot:false,is_restricted:false,is_ultra_restricted:false});
function fixture(options: {gate?: boolean; fail?: string} = {}) {
  let pages = 0;
  const read = vi.fn(async (name: string, use: (token: string) => Promise<unknown>) => { expect(name).toBe('slack-bot'); return use('SECRET'); });
  const request = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    expect(String(url)).toMatch(/^https:\/\/slack.com\/api\//);
    expect(init?.redirect).toBe('error');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init?.headers).toMatchObject({Authorization:'Bearer SECRET'});
    const method = String(url).split('/').at(-1)!;
    const fields = init?.body as URLSearchParams;
    let data: unknown;
    if (options.fail === method) data = {ok:false,error:'ratelimited'};
    else if (method === 'conversations.info') data = {ok:true, channel:{id:fields.get('channel'),is_mpim:true,is_im:true,user:'U111'}};
    else if (method === 'conversations.members') data = {ok:true, members:++pages === 1 ? ['U999','U111'] : ['U222'],response_metadata:{next_cursor:pages === 1 ? 'next' : ''}};
    else data = {ok:true,user:human(fields.get('user')!)};
    return Response.json(data);
  });
  const api = slackApi({withValue:read as any}, () => options.gate !== false, request as typeof fetch);
  return {api,read,request};
}
describe('Slack service API inspection', () => {
  it('reads every page and checks every human afresh, using withValue for each request', async () => {
    const f = fixture();
    expect(await f.api.inspect(venue,message)).toEqual({kind:'allow',members:['U999','U111','U222']});
    expect(f.request).toHaveBeenCalledTimes(5); expect(f.read).toHaveBeenCalledTimes(5);
    expect((f.request.mock.calls[2][1]?.body as URLSearchParams).get('cursor')).toBe('next');
    // New inspection must not reuse the preceding allowed membership/user evidence.
    f.request.mockResolvedValueOnce(Response.json({ok:true,channel:{id:'G123',is_mpim:false}}));
    expect(await f.api.inspect(venue,message)).toBe('drop');
  });
  it('validates the authenticated IM participant and checks its user', async () => {
    const f = fixture();
    expect(await f.api.inspect(venue,{...message,channel:'D123',dm:true,group:false})).toBe('allow');
    expect(f.request).toHaveBeenCalledTimes(2);
    f.request.mockResolvedValueOnce(Response.json({ok:true,channel:{id:'D123',is_im:true,user:'U222'}}));
    expect(await f.api.inspect(venue,{...message,channel:'D123',dm:true,group:false})).toBe('drop');
  });
  it('staging blocks even credential acquisition', async () => {
    const f = fixture({gate:false}); expect(await f.api.inspect(venue,message)).toBe('wait');
    expect(f.read).not.toHaveBeenCalled(); expect(f.request).not.toHaveBeenCalled();
  });
  it.each(['conversations.info','conversations.members','users.info'])('temporary failure in %s waits', async fail => {
    expect(await fixture({fail}).api.inspect(venue,message)).toBe('wait');
  });
  it.each([
    {team_id:'T999'}, {deleted:true}, {is_bot:true}, {is_restricted:true}, {is_ultra_restricted:true}, {is_stranger:true},
    {deleted:undefined}, {id:'U333'},
  ])('refuses unsafe/malformed human %j', async patch => {
    const f = fixture();
    // Use a DM so the second call is users.info.
    f.request.mockResolvedValueOnce(Response.json({ok:true,channel:{id:'D123',is_im:true,user:'U111'}}));
    f.request.mockResolvedValueOnce(Response.json({ok:true,user:{...human('U111'),...patch}}));
    expect(await f.api.inspect(venue,{...message,channel:'D123',dm:true,group:false})).toBe(patch.id ? 'wait' : 'drop');
  });
  it.each([
    {members:['U999','U111'],response_metadata:{next_cursor:''}},
    {members:['U999','U222','U333'],response_metadata:{next_cursor:''}},
    {members:['U111','U222','U333'],response_metadata:{next_cursor:''}},
  ])('refuses incomplete group membership %j', async page => {
    const f = fixture();
    f.request.mockResolvedValueOnce(Response.json({ok:true,channel:{id:'G123',is_mpim:true}}));
    f.request.mockResolvedValueOnce(Response.json({ok:true,...page}));
    expect(await f.api.inspect(venue,message)).toBe('drop');
  });
  it.each([
    {members:['U999','U111','U111'],response_metadata:{next_cursor:''}},
    {members:['U999','U111','U222']},
    {members:['U999',42],response_metadata:{next_cursor:''}},
  ])('waits on malformed/incomplete pagination %j', async page => {
    const f = fixture();
    f.request.mockResolvedValueOnce(Response.json({ok:true,channel:{id:'G123',is_mpim:true}}));
    f.request.mockResolvedValueOnce(Response.json({ok:true,...page}));
    expect(await f.api.inspect(venue,message)).toBe('wait');
  });
  it('ends repeated cursors without granting partial membership', async () => {
    const f = fixture();
    f.request.mockResolvedValueOnce(Response.json({ok:true,channel:{id:'G123',is_mpim:true}}));
    f.request.mockResolvedValueOnce(Response.json({ok:true,members:['U999','U111'],response_metadata:{next_cursor:'x'}}));
    f.request.mockResolvedValueOnce(Response.json({ok:true,members:['U222'],response_metadata:{next_cursor:'x'}}));
    expect(await f.api.inspect(venue,message)).toBe('wait'); expect(f.request).toHaveBeenCalledTimes(3);
  });
  it('credential loss mid-pagination waits and never returns partial evidence', async () => {
    const f = fixture(); f.read.mockImplementationOnce(async (_name,use) => use('SECRET'));
    f.read.mockRejectedValueOnce(Error('SECRET holder failure'));
    expect(await f.api.inspect(venue,message)).toBe('wait'); expect(f.request).toHaveBeenCalledTimes(1);
  });
  it.each([302,429,500])('HTTP %s waits without exposing the response', async status => {
    const f = fixture(); f.request.mockResolvedValueOnce(new Response('SECRET',{status}));
    expect(await f.api.inspect(venue,message)).toBe('wait');
  });
  it('classifies definite platform refusal even when withValue sanitizes callback exceptions', async () => {
    const f = fixture();
    f.read.mockImplementation(async (_name,use) => { try { return await use('SECRET'); } catch { throw Error('Secret use failed'); } });
    f.request.mockResolvedValueOnce(Response.json({ok:false,error:'channel_not_found'}));
    expect(await f.api.inspect(venue,message)).toBe('drop');
  });
  it('bounds response size and does not leak malformed or upstream responses', async () => {
    const f = fixture(); f.request.mockResolvedValueOnce(new Response('SECRET'.repeat(200_000)));
    expect(await f.api.inspect(venue,message)).toBe('wait');
    f.request.mockRejectedValueOnce(Error('SECRET'));
    expect(await f.api.inspect(venue,message)).toBe('wait');
  });
});
