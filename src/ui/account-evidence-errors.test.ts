import {expect,it} from 'vitest';
import {accountEvidenceError} from '../../scripts/rebuild-account-evidence-errors.mjs';
const key='Fictional/private+key==';
it.each([key,encodeURIComponent(key),'Fictional_private-key',key.slice(0,12),'Fictional/\nprivate+key=='])('withholds arbitrary protocol and cleanup diagnostics after key capture: %s',form=>{const error=accountEvidenceError(Error('Failure '+form+' /login/fake-link'),key);expect(error.message).toBe('Passkey browser evidence failed after virtual credential capture');expect(error.message).not.toContain(form);});
it('retains useful errors before key capture while hiding a login link',()=>{expect(accountEvidenceError(Error('Early failure /login/fake-link'),'').message).toBe('Error: Early failure /login/[redacted]');});
