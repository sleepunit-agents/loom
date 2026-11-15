import {it,expect,vi} from 'vitest';
import {maskCredentialScreenshots} from './rebuild-credential-evidence.mjs';
it('masks credentials in screenshots requested by later helpers, preserving their options and masks',async()=>{
 const capture=vi.fn(async options=>options),credential={},existing={};
 const page={screenshot:capture,locator:vi.fn(()=>credential)};
 maskCredentialScreenshots(page);
 await page.screenshot({path:'later-helper-failed.png',fullPage:true,mask:[existing]});
 expect(page.locator).toHaveBeenCalledWith('[data-signin-link], [aria-label="Token value"]');
 expect(capture).toHaveBeenCalledWith({path:'later-helper-failed.png',fullPage:true,mask:[existing,credential]});
 await page.screenshot({path:'another-helper.png'});
 expect(capture).toHaveBeenLastCalledWith({path:'another-helper.png',mask:[credential]});
});
it('keeps a link masked when Account fails after issuance and a different helper takes a failure screenshot',async()=>{
 const {accessAction}=await import('./rebuild-access-actions.mjs');
 const credential={},capture=vi.fn(async()=>{}),page={screenshot:capture,locator:vi.fn(()=>credential),waitForResponse:async()=>({ok:()=>true})};
 maskCredentialScreenshots(page);
 const click=vi.fn(async()=>{}),tile={getByRole:()=>({click}),locator:()=>({waitFor:async()=>{}})};
 // A successful HTTP issuance followed by a persistence assertion failure:
 // the link is already visible, and Account never reaches its Hide control.
 const app={services:{comms:{db:{$client:{prepare:()=>({get:()=>({n:0})})}}}}};
 const result=await accessAction({page,tile,title:'Your account',app,out:'/unused'});
 expect(click).toHaveBeenCalledOnce();expect(result).toMatchObject({ok:false,error:'Error: No one-time sign-in link persisted'});expect(capture).not.toHaveBeenCalled();
 await page.screenshot({path:'comms-failed.png',fullPage:true});
 expect(capture).toHaveBeenCalledWith({path:'comms-failed.png',fullPage:true,mask:[credential]});
});
