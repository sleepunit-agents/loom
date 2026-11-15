import {expect,it} from 'vitest';
import {accountEvidenceError} from './account-evidence-errors.js';
const key='Fictional/private+key==';
it.each([key,encodeURIComponent(key),key.replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')])('redacts the copied key from protocol and cleanup errors: %s',form=>{const error=accountEvidenceError(Error('Protocol or cleanup failed: '+form+' /login/fake-link'),key);expect(error.message).not.toContain(form);expect(error.message).not.toContain('/login/fake-link');expect(error.message).toContain('[virtual key redacted]');expect(error.message).toContain('Protocol or cleanup failed');});
it('retains useful errors before a key exists while still hiding a login link',()=>{expect(accountEvidenceError(Error('Early failure /login/fake-link'),'').message).toBe('Error: Early failure /login/[redacted]');});
