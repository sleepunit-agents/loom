import {afterEach,beforeEach,expect,it,vi} from 'vitest';
const f=vi.hoisted(()=>({operation:vi.fn()}));
vi.mock('../data/operation',()=>({memberOperation:f.operation}));
import {sessionChange} from './session-change';
beforeEach(()=>{vi.clearAllMocks();f.operation.mockResolvedValue({});vi.stubGlobal('location',{reload:vi.fn()});});afterEach(()=>vi.unstubAllGlobals());
it.each([true,false])('reloads only after confirmed loss of browser identity (operation succeeded: %s)',async succeeded=>{
 if(!succeeded)f.operation.mockRejectedValue(Error('Could not save'));
 const fetch=vi.fn().mockResolvedValue(Response.json({viewer:null}));vi.stubGlobal('fetch',fetch);
 expect(await sessionChange('account.revokeSession',{ref:'selected-browser'})).toBe('signed-out');expect(location.reload).toHaveBeenCalledOnce();expect(f.operation).toHaveBeenCalledExactlyOnceWith('account.revokeSession',{ref:'selected-browser'});expect(fetch).toHaveBeenCalledExactlyOnceWith('/auth/session',{credentials:'same-origin',cache:'no-store',redirect:'error'});
});
it('keeps a browser signed in after ending another browser',async()=>{vi.stubGlobal('fetch',vi.fn().mockResolvedValue(Response.json({viewer:{id:'sam'}})));expect(await sessionChange('account.revokeSession',{ref:'other-browser'})).toBe('saved');expect(location.reload).not.toHaveBeenCalled();});
it('does not report a refused revocation as saved when identity remains',async()=>{f.operation.mockRejectedValue(Error('Could not save'));vi.stubGlobal('fetch',vi.fn().mockResolvedValue(Response.json({viewer:{id:'sam'}})));await expect(sessionChange('account.revokeSession',{ref:'other-member'})).rejects.toThrow('Could not save');expect(location.reload).not.toHaveBeenCalled();expect(f.operation).toHaveBeenCalledOnce();});
it.each(['network','http','malformed'])('does not infer signed out from a failed identity check: %s',async reason=>{const fetch=vi.fn();if(reason==='network')fetch.mockRejectedValue(Error('offline'));else fetch.mockResolvedValue(reason==='http'?new Response('Denied',{status:403}):Response.json({}));vi.stubGlobal('fetch',fetch);await expect(sessionChange('token.revoke',{fingerprint:'selected-token'})).rejects.toThrow();expect(location.reload).not.toHaveBeenCalled();expect(f.operation).toHaveBeenCalledOnce();});
