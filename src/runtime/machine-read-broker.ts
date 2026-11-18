import { randomUUID } from 'node:crypto';

import { looksLikeCredential, machineReadOutputBytes } from './machine-read-catalog.js';
export type ReadAnswer = {lines: string[]} | {refusal: string};
type Request = {id: string; read: string; args: Record<string, string | number>};
type Pending = {
  request: Request;
  permitted: () => boolean;
  deadline: number;
  taken: boolean;
  end: (answer: ReadAnswer) => void;
};

/** Each server owns its waiting calls. A worker restart can lose a read, but cannot replay one. */
export class MachineReadBroker {
  private readonly pending = new Map<string, Pending>();

  ask(machine: string, read: string, args: Request['args'], permitted: () => boolean, signal?: AbortSignal): Promise<ReadAnswer> {
    if (signal?.aborted || !permitted()) return Promise.resolve({refusal: 'Machine read refused'});
    if (this.pending.has(machine)) return Promise.resolve({refusal: 'Machine already answering a read'});
    return new Promise(resolve => {
      const end = (answer: ReadAnswer) => {
        signal?.removeEventListener('abort', cancel);
        clearTimeout(timer);
        this.pending.delete(machine);
        resolve(answer);
      };
      const cancel = () => end({refusal: 'Machine read cancelled'});
      const timer = setTimeout(() => end({refusal: 'Machine read timed out'}), 30000);
      signal?.addEventListener('abort',cancel,{once:true});
      this.pending.set(machine, {request: {id: randomUUID(), read, args}, deadline: Date.now()+30000, permitted, taken: false, end});
    });
  }

  private current(machine: string) {
    const pending = this.pending.get(machine);
    if (!pending) return;
    if (Date.now() >= pending.deadline) pending.end({refusal: 'Machine read timed out'});
    else if (!pending.permitted()) pending.end({refusal: 'Machine read refused'});
    else return pending;
  }

  close() {
    for (const pending of this.pending.values()) pending.end({refusal: 'Machine read interrupted'});
  }

  next(machine: string) {
    const pending = this.current(machine);
    if (!pending || pending.taken) return null;
    pending.taken = true;
    return pending.request;
  }

  finish(machine: string, id: string, output: string, ok = true) {
    const pending = this.current(machine);
    if (!pending?.taken || pending.request.id !== id) return false;
    if (Buffer.byteLength(output) > machineReadOutputBytes) pending.end({refusal: 'Machine answer too big'});
    else if (!ok) pending.end({refusal: output === 'Machine read exceeds the output limit' ? 'Machine answer too big' : 'Machine read unavailable'});
    else if (looksLikeCredential(output)) pending.end({refusal:'Machine answer contains a credential'});
    else pending.end({lines: output.split(/\r?\n/)});
    return true;
  }
}
