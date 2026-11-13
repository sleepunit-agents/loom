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
    else if (method === 'conversations.info') data = {ok:true, channel:{id:fields.get('channel'),is_mpim:!fields.get('channel')!.startsWith('D'),is_im:fields.get('channel')!.startsWith('D'),user:'U111'}};
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
    f.request.mockResolvedValueOnce(Response.json({ok:true,channel:{id:'G123',is_mpim:false,is_im:false}}));
    expect(await f.api.inspect(venue,message)).toBe('drop');
  });
  it('validates the authenticated IM participant and checks its user', async () => {
    const f = fixture();
    expect(await f.api.inspect(venue,{...message,channel:'D123',dm:true,group:false})).toEqual({kind:'allow',members:['U999','U111']});
    expect(f.request).toHaveBeenCalledTimes(2);
    f.request.mockResolvedValueOnce(Response.json({ok:true,channel:{id:'D123',is_im:true,is_mpim:false,user:'U222'}}));
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
    f.request.mockResolvedValueOnce(Response.json({ok:true,channel:{id:'D123',is_im:true,is_mpim:false,user:'U111'}}));
    f.request.mockResolvedValueOnce(Response.json({ok:true,user:{...human('U111'),...patch}}));
    expect(await f.api.inspect(venue,{...message,channel:'D123',dm:true,group:false})).toBe(patch.id || Object.values(patch).includes(undefined) ? 'wait' : 'drop');
  });
  it.each([
    {members:['U999','U111'],response_metadata:{next_cursor:''}},
    {members:['U999','U222','U333'],response_metadata:{next_cursor:''}},
    {members:['U111','U222','U333'],response_metadata:{next_cursor:''}},
  ])('refuses incomplete group membership %j', async page => {
    const f = fixture();
    f.request.mockResolvedValueOnce(Response.json({ok:true,channel:{id:'G123',is_mpim:true,is_im:false}}));
    f.request.mockResolvedValueOnce(Response.json({ok:true,...page}));
    expect(await f.api.inspect(venue,message)).toBe('drop');
  });
  it.each([
    {members:['U999','U111','U111'],response_metadata:{next_cursor:''}},
    {members:['U999','U111','U222']},
    {members:['U999',42],response_metadata:{next_cursor:''}},
  ])('waits on malformed/incomplete pagination %j', async page => {
    const f = fixture();
    f.request.mockResolvedValueOnce(Response.json({ok:true,channel:{id:'G123',is_mpim:true,is_im:false}}));
    f.request.mockResolvedValueOnce(Response.json({ok:true,...page}));
    expect(await f.api.inspect(venue,message)).toBe('wait');
  });
  it('ends repeated cursors without granting partial membership', async () => {
    const f = fixture();
    f.request.mockResolvedValueOnce(Response.json({ok:true,channel:{id:'G123',is_mpim:true,is_im:false}}));
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
    const f = fixture(); f.request.mockResolvedValueOnce(Response.json({ok:true,channel:{id:'G123',is_mpim:true,is_im:false},padding:'x'.repeat(1024*1024)}));
    expect(await f.api.inspect(venue,message)).toBe('wait');
    f.request.mockRejectedValueOnce(Error('SECRET'));
    expect(await f.api.inspect(venue,message)).toBe('wait');
  });
});

it('uses the real bridges service grant, erases holder bytes and rechecks revocation between HTTP calls', async () => {
  const {mkdtempSync, rmSync} = await import('node:fs');
  const {tmpdir} = await import('node:os'); const {join} = await import('node:path');
  const {startLoom} = await import('../../foundation.js');
  const {fixture: homeFixture, fixtureSharing} = await import('../../fixture.js');
  const {FakeClock} = await import('../../core/index.js');
  const {installSecrets} = await import('../secrets/index.js');
  const {installSecretServices, secretUseRole} = await import('../secrets/service.js');
  const home = mkdtempSync(join(tmpdir(),'slack-service-')); homeFixture(home);
  const config = {...fixtureSharing(),services:{bridges:{types:[],operations:[]}}};
  const sharing = () => config, clock = new FakeClock();
  const app = await startLoom({home,next:true,staging:true,clock,sharing,install(a) {
    installSecrets(a.db,a.operations,a.live,sharing); installSecretServices(a.db,a.operations,sharing);
  }});
  try {
    let seq = 0;
    const call = (name: string,input: unknown) => app.operations.call('direct',{kind:'member',id:'jonathan'},`secrets.${name}`,input,`slack-${++seq}`);
    expect(call('describe',{name:venue.tokenSecret,description:'Slack bot'}).ok).toBe(true);
    const bytes: Uint8Array[] = [];
    const source = {read:vi.fn(async () => {const b=Buffer.from('CREDENTIAL-SENTINEL'); bytes.push(b); return b;})};
    const use = secretUseRole(app.db,source,sharing,{kind:'service',id:'bridges'},()=>clock.now(),app.live);
    const request = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({Authorization:'Bearer CREDENTIAL-SENTINEL'});
      expect(call('revokeService',{service:'bridges',name:venue.tokenSecret}).ok).toBe(true);
      return Response.json({ok:true,channel:{id:'G123',is_mpim:true,is_im:false}});
    });
    const api = slackApi(use,()=>true,request as typeof fetch);
    expect(await api.inspect(venue,message)).toBe('wait');
    expect(source.read).not.toHaveBeenCalled(); expect(request).not.toHaveBeenCalled();
    expect(call('grantService',{service:'bridges',name:venue.tokenSecret}).ok).toBe(true);
    expect(await api.inspect(venue,message)).toBe('wait');
    expect(source.read).toHaveBeenCalledTimes(1); expect(request).toHaveBeenCalledTimes(1);
    expect(bytes[0].every(n=>n===0)).toBe(true);
    const tables = app.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {name:string}[];
    const dump = tables.map(t=>app.db.prepare(`SELECT * FROM "${t.name.replaceAll('"','""')}"`).all());
    expect(JSON.stringify(dump)).not.toContain('CREDENTIAL-SENTINEL');
  } finally {await app.close(); rmSync(home,{recursive:true,force:true});}
});

it.each([
  {id:'D123',is_im:true,is_mpim:true,user:'U111'},
  {id:'D123',is_im:true,is_mpim:false},
  {id:'D123',is_im:true,user:'U111'},
  {id:'D123',is_mpim:false,user:'U111'},
])('waits on incomplete/contradictory channel evidence %j', async channel => {
  const f=fixture(); f.request.mockResolvedValueOnce(Response.json({ok:true,channel}));
  expect(await f.api.inspect(venue,{...message,channel:'D123',dm:true,group:false})).toBe('wait');
});
it('waits on malformed stranger evidence', async () => {
  const f=fixture();
  f.request.mockResolvedValueOnce(Response.json({ok:true,channel:{id:'D123',is_im:true,is_mpim:false,user:'U111'}}));
  f.request.mockResolvedValueOnce(Response.json({ok:true,user:{...human('U111'),is_stranger:'true'}}));
  expect(await f.api.inspect(venue,{...message,channel:'D123',dm:true,group:false})).toBe('wait');
});
it('enforces the fifteen-second timeout for an abort-aware hung request', async () => {
  vi.useFakeTimers();
  const timeout = vi.spyOn(AbortSignal,'timeout').mockImplementation(ms => {
    const controller = new AbortController(); setTimeout(()=>controller.abort(),ms); return controller.signal;
  });
  try {
    const f=fixture(); let settled = false;
    const request = vi.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve,reject) => {
      init?.signal?.addEventListener('abort',()=>reject(Error('SECRET')), {once:true});
    }));
    const result=slackApi({withValue:f.read as any},()=>true,request as typeof fetch).inspect(venue,message).then(value=>{settled=true;return value;});
    await vi.advanceTimersByTimeAsync(14_999); expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1); expect(await result).toBe('wait');
    expect(timeout).toHaveBeenCalledWith(15_000);
  } finally {timeout.mockRestore(); vi.useRealTimers();}
});
it('rechecks staging between calls before obtaining another credential', async () => {
  const f=fixture(); let open=true;
  f.request.mockImplementationOnce(async()=>{open=false;return Response.json({ok:true,channel:{id:'G123',is_mpim:true,is_im:false}});});
  expect(await slackApi({withValue:f.read as any},()=>open,f.request as typeof fetch).inspect(venue,message)).toBe('wait');
  expect(f.read).toHaveBeenCalledTimes(1); expect(f.request).toHaveBeenCalledTimes(1);
});
it.each([{}, {ok:null}, {ok:'false'}])('waits rather than permanently dropping malformed denial envelope %j', async envelope => {
  const f=fixture(); f.request.mockResolvedValueOnce(Response.json({...envelope,error:'channel_not_found'}));
  expect(await f.api.inspect(venue,message)).toBe('wait');
});
it.each(['workspace','bot','channel','user'])('waits on malformed %s input before credentials or HTTP', async field => {
  const f=fixture();
  const v={...venue,...(['workspace','bot'].includes(field)?{[field]:''}:{})};
  const m={...message,...(['channel','user'].includes(field)?{[field]:''}:{})};
  expect(await f.api.inspect(v,m)).toBe('wait');
  expect(f.read).not.toHaveBeenCalled(); expect(f.request).not.toHaveBeenCalled();
});
it.each(['missing_scope','account_inactive'])('waits for repair of bot credential/configuration failure %s', async error => {
  const f=fixture(); f.request.mockResolvedValueOnce(Response.json({ok:false,error}));
  expect(await f.api.inspect(venue,message)).toBe('wait');
});
it.each(['membership','eligibility'])('refreshes %s even when channel remains an allowed MPIM', async change => {
  const f=fixture(); expect(await f.api.inspect(venue,message)).toEqual({kind:'allow',members:['U999','U111','U222']});
  const last=change==='membership'?'U333':'U222';
  f.request.mockResolvedValueOnce(Response.json({ok:true,channel:{id:'G123',is_mpim:true,is_im:false}}));
  f.request.mockResolvedValueOnce(Response.json({ok:true,members:['U999','U111',last],response_metadata:{next_cursor:''}}));
  f.request.mockResolvedValueOnce(Response.json({ok:true,user:human('U111')}));
  f.request.mockResolvedValueOnce(Response.json({ok:true,user:{...human(last),is_restricted:change==='eligibility'}}));
  expect(await f.api.inspect(venue,message)).toEqual(change==='membership'?{kind:'allow',members:['U999','U111','U333']}:'drop');
  expect(f.request).toHaveBeenCalledTimes(9);
  expect((f.request.mock.calls[8][1]?.body as URLSearchParams).get('user')).toBe(last);
});
