import { expect, it, vi } from 'vitest';
import { refreshChanges, RefreshError } from './work-refresh';
it('refreshes through native cookies without actor metadata and never retries failed acknowledgements',async()=>{
  const request=vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ok:true,value:{refreshed:true}}))
    .mockRejectedValueOnce(new Error('lost')).mockResolvedValueOnce(Response.json({ok:false},{status:403}))
    .mockResolvedValueOnce(Response.json({ok:true,value:{refreshed:false}})).mockResolvedValueOnce(new Response('invalid'));
  await refreshChanges(request);
  for(let n=0;n<4;n++)await expect(refreshChanges(request)).rejects.toThrow('Could not refresh Changes.');
  expect(request).toHaveBeenCalledTimes(5);
  for(const [url,init] of request.mock.calls){expect(url).toBe('/api/changes/refresh');expect(init).toMatchObject({method:'POST',credentials:'same-origin'});expect(JSON.parse(String(init!.body))).toEqual({input:{}});}
});

it('says which failure was loom refusing the member, by the door\'s status, with the same message', async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ ok: false }, { status: 403 }))
    .mockResolvedValueOnce(Response.json({ ok: false }, { status: 503 })).mockRejectedValueOnce(new Error('lost'));
  for (const status of [403, 503, null]) {
    const error = await refreshChanges(request).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RefreshError);
    expect(error).toMatchObject({ status, message: 'Could not refresh Changes.' });
  }
});
