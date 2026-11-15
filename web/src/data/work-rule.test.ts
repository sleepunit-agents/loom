import {expect,it,vi} from 'vitest';
import {sendApprovalRule} from './work-rule';
import type {ApprovalRuleInput} from '../pieces/approval-view/rule-editor';
it('sends only normalized rule fields and the explicit intent, and rejects unknown or mismatched acknowledgments without retry',async()=>{
 const input={kind:'merge' as const,scope:' github:ACME/* ',person:' sam ',tier:'tell' as const};
 const request=vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ok:true,value:{kind:'merge',scope:'github:acme/*',person:'sam'}}))
  .mockRejectedValueOnce(new Error('lost')).mockResolvedValueOnce(Response.json({ok:true,value:{kind:'merge',scope:'*',person:'sam'}})).mockResolvedValueOnce(Response.json({ok:false},{status:403}))
  .mockResolvedValueOnce(Response.json({ok:true,value:{kind:'setting',scope:'github:acme/*',person:'sam'}}))
  .mockResolvedValueOnce(Response.json({ok:true,value:{kind:'merge',scope:'github:acme/*',person:'lee'}}));
 await sendApprovalRule({...input,actor:'other'} as ApprovalRuleInput,'intent',request);
 for(let n=0;n<5;n++)await expect(sendApprovalRule(input,'intent',request)).rejects.toThrow('Could not confirm');
 expect(request).toHaveBeenCalledTimes(6);
 for(const [url,init] of request.mock.calls){expect(url).toBe('/api/approvals/setRule');expect(init).toMatchObject({method:'POST',credentials:'same-origin'});expect(JSON.parse(String(init!.body))).toEqual({input:{kind:'merge',scope:'github:acme/*',person:'sam',tier:'tell'},id:'intent'});}
});
