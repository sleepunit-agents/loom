import { expect, it, vi } from 'vitest';
import { readProposal } from './work-proposal';
it('reads what a waiting household card would replace, and answers with nothing for anyone refused or anything malformed', async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ok:true,value:{summary:'member lee: {"role":"member"} → {"role":"owner"}',problem:null}}))
    .mockResolvedValueOnce(Response.json({ok:true,value:{summary:'Revoke token spare: null → revoked',problem:'No live token has that label'}}))
    .mockResolvedValueOnce(Response.json({ok:false,code:'denied',message:'Permission denied'},{status:403}))
    .mockResolvedValueOnce(Response.json({ok:true,value:{summary:7,problem:null}}))
    .mockResolvedValueOnce(new Response('not json')).mockRejectedValueOnce(new Error('offline'));
  expect(await readProposal('a-1',request)).toEqual({summary:'member lee: {"role":"member"} → {"role":"owner"}',problem:null,card:null,blocked:null});
  expect(await readProposal('a-2',request)).toEqual({summary:'Revoke token spare: null → revoked',problem:'No live token has that label',card:null,blocked:null});
  for (let n=0;n<4;n++) expect(await readProposal('a-3',request)).toBeUndefined();
  expect(request.mock.calls[0][0]).toBe('/api/household/proposal');
  expect(request.mock.calls[0][1]).toMatchObject({method:'POST',credentials:'same-origin',body:JSON.stringify({input:{id:'a-1'}})});
});
it('reads the card as an owner is told it, and the line that says it cannot be allowed', async () => {
  const card={title:'Let Gage Taylor (Slack) use Art’s pond kit',nothing:false,facts:[{label:'Who',value:'Gage Taylor, on Slack'},{label:'Account id',value:'U1',small:true}],exact:[{label:'to.user',value:'U1'}]};
  const request = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ok:true,value:{summary:'Who: Gage Taylor, on Slack',problem:null,card,blocked:'This cannot be allowed yet: …'}}))
    .mockResolvedValueOnce(Response.json({ok:true,value:{summary:'x',problem:null,card:{title:'T',facts:[{label:'Who',value:7}],exact:[]},blocked:7}}));
  expect(await readProposal('a-1',request)).toEqual({summary:'Who: Gage Taylor, on Slack',problem:null,card,blocked:'This cannot be allowed yet: …'});
  // A card that is not well formed is left out; the words read before it still stand.
  expect(await readProposal('a-2',request)).toEqual({summary:'x',problem:null,card:null,blocked:null});
});
