/** Trusted owner startup composition. This command must implement fd3-to-EOF;
 * ClaudeWorkerSession's prompt protocol does not implement that contract. */
import {startSecretCommand,type SecretCommandConfig,type SecretCommandRequest} from './secret-command.js';
import {workerAdmission} from '../pieces/secrets/worker-admission.js';
import type {LocalHolderConfig} from '../pieces/secrets/local-holder.js';

export async function startAdmittedSecretCommand(config:SecretCommandConfig&{admission:LocalHolderConfig},
  request:SecretCommandRequest&{name:string}) {
  // Snapshot admission configuration and name before command startup awaits.
  const admission={...config.admission},pin=config.daemonFingerprint,name=request.name;
  const command=await startSecretCommand(config,request);
  let client:ReturnType<typeof workerAdmission>;
  try {client=workerAdmission(admission,pin,command.pending.id);}
  catch {await command.close();throw new Error('Worker admission unavailable');}
  const close=async()=>{await Promise.all([command.close(),client.close()]);};
  const delivery=(async()=>{
    try {
      const ticketId=await client.admit(name);
      command.bindTicket(ticketId);
      await client.dispatch();return true;
    }catch {await close();return false;}
    finally {await client.close();}
  })();
  return Object.freeze({completed:command.completed,delivery,close});
}
