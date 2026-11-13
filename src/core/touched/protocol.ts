import { StringDecoder } from 'node:string_decoder';
import { z } from 'zod';
export const touchChange = z.object({ type: z.string().min(1).max(80), id: z.string().min(1).max(2048) }).strict();
/** Unix streams may split inside a UTF-8 character; count wire bytes before decoding. */
export function touchReader() {
  const decoder = new StringDecoder('utf8');
  let body = '', bytes = 0;
  return (chunk: Buffer) => {
    bytes += chunk.byteLength;
    if (bytes > 4096) throw new Error('Touch frame too large');
    body += decoder.write(chunk);
    const end = body.indexOf('\n');
    return end < 0 ? undefined : touchChange.parse(JSON.parse(body.slice(0, end)));
  };
}
