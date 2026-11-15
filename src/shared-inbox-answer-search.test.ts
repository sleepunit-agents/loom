import {afterEach,expect,it,vi} from 'vitest';
import {eq} from 'drizzle-orm';
import {bodyFixture,bodyCredentials as raw} from '../test/fixtures/conversation-body.js';
import * as s from './core/data/schema.js';
const clean:(()=>void|Promise<void>)[]=[];afterEach(async()=>{vi.restoreAllMocks();for(const close of clean.splice(0).reverse())await close();});
it('finds a retained person answer through the real Root search and withholds its matching ID if that answer expires before publication',async()=>{
 const f=await bodyFixture(clean);const digest=await f.call('digest',{summary:'Choose a fixture',question:{to:'alice',answers:'words',words:'Which fixture?'}},'ask');expect(digest.status).toBe(200);const id=(await digest.json()).value.item;
 const answered=await f.root.http.request('/api/inbox/answer',{method:'POST',headers:{cookie:'loom_ui='+raw.memberCookie,'content-type':'application/json'},body:JSON.stringify({input:{item:id,answer:'words',words:'PRIVATE SEARCH ANSWER'},id:'answer'})});expect(answered.status).toBe(200);
 const deadline=f.clock.now()+1000;f.root.writes.run(()=>f.db.update(s.messages).set({keepUntil:new Date(deadline).toISOString()}).where(eq(s.messages.kind,'answer')).run());
 const search=()=>f.root.http.request('/graphql',{method:'POST',headers:{cookie:'loom_ui='+raw.memberCookie,'content-type':'application/json'},body:JSON.stringify({query:'{inboxItems(folder:"answered",search:"PRIVATE SEARCH ANSWER"){id}}'})});
 const fresh=await search();expect(await fresh.json()).toEqual({data:{inboxItems:[{id}]}});
 const delayed=await search(),clone=delayed.clone();vi.spyOn(f.clock,'now').mockReturnValue(deadline);await expect(delayed.text()).rejects.toThrow();await expect(clone.text()).rejects.toThrow();
 expect(f.db.$client.serialize().includes(Buffer.from('PRIVATE SEARCH ANSWER'))).toBe(false);
});
