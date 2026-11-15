import { sha256 } from '@noble/hashes/sha2.js';
/** An immutable card/head answer is one intent across reloads, without storing
 * words or records. Core scopes its receipt to the actual authenticated caller. */
export type WorkAnswer = {piece:'approvals';id:string;answer:'allow'|'deny'}
  | {piece:'changes';id:string;head:string;approval:string;answer:'yes'|'no'};
export async function sendWorkAnswer(command: WorkAnswer, request: typeof fetch = fetch): Promise<void> {
  const input = command.piece === 'approvals' ? {id:command.id,answer:command.answer}
    : {id:command.id,head:command.head,approval:command.approval,answer:command.answer};
  const digest = sha256(new TextEncoder().encode(JSON.stringify([command.piece,input])));
  const id = 'work-' + Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('');
  let response: Response, result: unknown;
  try {
    response = await request(`/api/${command.piece}/answer`,{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({input,id})});
    result = await response.json();
  } catch { throw new Error('Could not confirm your answer. Try again.'); }
  if (!response.ok || !result || typeof result !== 'object' || !('ok' in result) || result.ok !== true
    || !('value' in result) || !result.value || typeof result.value !== 'object' || !('id' in result.value) || result.value.id !== command.id)
    throw new Error('Could not confirm your answer. Try again.');
}
