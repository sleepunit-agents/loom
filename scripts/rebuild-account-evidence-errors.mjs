/** A copied key makes arbitrary protocol errors unsafe to publish, including fragments. */
export function accountEvidenceError(error,key){
 if(key)return Error('Passkey browser evidence failed after virtual credential capture');
 return Error(String(error).replace(/\/login\/[a-zA-Z0-9_-]+/g,'/login/[redacted]'));
}
