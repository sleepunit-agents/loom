import { expect, it, vi } from 'vitest';
import { readProposal } from './work-proposal';
it('reads what a waiting household card would replace, and answers with nothing for anyone refused or anything malformed', async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ok:true,value:{summary:'member lee: {"role":"member"} → {"role":"owner"}',problem:null}}))
    .mockResolvedValueOnce(Response.json({ok:true,value:{summary:'Revoke token spare: null → revoked',problem:'No live token has that label'}}))
    .mockResolvedValueOnce(Response.json({ok:false,code:'denied',message:'Permission denied'},{status:403}))
    .mockResolvedValueOnce(Response.json({ok:true,value:{summary:7,problem:null}}))
    .mockResolvedValueOnce(new Response('not json')).mockRejectedValueOnce(new Error('offline'));
  expect(await readProposal('a-1',request)).toEqual({summary:'member lee: {"role":"member"} → {"role":"owner"}',problem:null});
  expect(await readProposal('a-2',request)).toEqual({summary:'Revoke token spare: null → revoked',problem:'No live token has that label'});
  for (let n=0;n<4;n++) expect(await readProposal('a-3',request)).toBeUndefined();
  expect(request.mock.calls[0][0]).toBe('/api/household/proposal');
  expect(request.mock.calls[0][1]).toMatchObject({method:'POST',credentials:'same-origin',body:JSON.stringify({input:{id:'a-1'}})});
});
