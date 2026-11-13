/** Local key-holder boundary. This is not a record or a registry operation.
 * Production transports must authenticate both ends over a private local pipe;
 * no TCP listener, no value in argv/environment, and no raw errors propagated.
 * handTo sends to a pre-authorised runtime sink, never returns bytes to loom.
 * The holder owns sops/age, its key, encrypted values and rotation.
 */
export interface KeyHolder {
  names(): readonly string[];
  set(name: string, value: Uint8Array, mode: 'add' | 'replace', operationId: string): void;
  handTo(name: string, sink: string): void;
  remove(name: string, operationId: string): void;
  rotate(operationId: string): void;
}
