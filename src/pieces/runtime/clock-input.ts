import type { Wake } from '../clock/role.js';
/** Syntax only. File bytes are resolved by the worker in its own checkout;
 * neither composition nor owning admission opens a daemon path. */
export function supportedClockPrompt(wake:Wake):boolean {
  const content=!!wake.prompt&&!wake.file&&!wake.prompt.includes('<!-- house: local -->')
    || !wake.prompt&&!!wake.file&&/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(wake.file)
      &&wake.file.length<=200&&wake.file.split('/').every(p=>p!=='.'&&p!=='..');
  return content&&!wake.continuation&&!wake.slot&&!wake.approval;
}
