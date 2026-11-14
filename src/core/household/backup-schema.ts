import { z } from 'zod';
import { isAbsolute } from 'node:path';
import { Encrypter } from 'age-encryption';
import { createPublicKey } from 'node:crypto';

/** Parse once for schema validation and the local filesystem boundary. */
export function parseBackupTarget(value: string): { localPath?: string } | undefined {
  if (/[\x00-\x1f\x7f]/.test(value)) return;
  if (value.startsWith('path:')) return isAbsolute(value.slice(5)) ? { localPath: value.slice(5) } : undefined;
  if (!value.startsWith('git:') || /\s/.test(value)) return;
  const url = value.slice(4);
  if (url.startsWith('-')) return;
  if (url.startsWith('/')) return { localPath: url };
  if (/^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^\s]+$/.test(url)) return {};
  try {
    const parsed = new URL(url);
    if (!['https:', 'ssh:', 'file:'].includes(parsed.protocol) || parsed.password || parsed.search || parsed.hash
      || parsed.protocol !== 'ssh:' && parsed.username) return;
    if (parsed.protocol !== 'file:') return parsed.host ? {} : undefined;
    const localPath = decodeURIComponent(parsed.pathname);
    if (!parsed.host && isAbsolute(localPath) && !/[\x00-\x1f\x7f]/.test(localPath)) return { localPath };
  } catch { /* invalid URLs and percent encoding */ }
}

/** Validate native age encoding/checksum or an SSH public-key wire envelope.
 * No private key, key generation, process or encryption happens here. */
export function validBackupRecipient(value: string): boolean {
  try {
    if (/^age1[0-9a-z]+$/.test(value)) {
      // The legacy native X25519 format only; do not silently add PQ/tag formats.
      if (value.length !== 62) return false;
      new Encrypter().addRecipient(value); return true;
    }
    const match = /^(ssh-ed25519|ssh-rsa) ([A-Za-z0-9+/]+={0,2})( [^\r\n]{0,100})?$/.exec(value);
    if (!match) return false;
    const data = Buffer.from(match[2], 'base64');
    if (data.toString('base64').replace(/=+$/, '') !== match[2].replace(/=+$/, '')) return false;
    let offset = 0;
    const field = () => {
      const size = data.readUInt32BE(offset); offset += 4;
      if (size > data.length - offset) throw Error('truncated key');
      const result = data.subarray(offset, offset + size); offset += size; return result;
    };
    if (field().toString('ascii') !== match[1]) return false;
    if (match[1] === 'ssh-ed25519') {
      const key = field();
      if (key.length !== 32 || key.every(byte => byte === 0)) return false;
      createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: key.toString('base64url') }, format: 'jwk' });
    } else {
      const positive = () => {
        let key = field();
        if (!key.length || key[0] & 0x80 || key.length > 1 && key[0] === 0 && !(key[1] & 0x80)) throw Error('invalid mpint');
        if (key[0] === 0) key = key.subarray(1);
        return key;
      };
      const e = positive(), n = positive();
      if (e.length > 4 || !e.length || n.length < 256 || n.length > 1024) return false;
      const exponent = Number(BigInt('0x' + e.toString('hex')));
      if (exponent < 3 || exponent % 2 === 0 || !(n[n.length - 1] & 1)) return false;
      createPublicKey({ key: { kty: 'RSA', e: e.toString('base64url'), n: n.toString('base64url') }, format: 'jwk' });
    }
    return offset === data.length;
  } catch { return false; }
}
const recipient = z.string().max(2000).refine(validBackupRecipient, 'Choose a valid age or SSH public recipient');
export const backupSettingsSchema = z.object({
  target: z.string().min(1).max(4096).refine(v => parseBackupTarget(v) !== undefined, 'Use a credential-free git URL or an absolute path target'),
  recipients: z.array(recipient).min(1).max(100).transform(v => [...new Set(v)]),
  at: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).default('03:00'),
  tz: z.string().max(100).refine(v => { try { new Intl.DateTimeFormat('en-US', { timeZone: v }); return true; } catch { return false; } }, 'Choose a time zone').default('UTC'),
  keep: z.number().int().min(1).max(90).default(7),
  required: z.array(z.string().regex(/^[a-z][a-z0-9-]{0,39}$/)).max(100).default([]).transform(v => [...new Set(v)]),
}).strict();
export const backupStatusSchema = z.object({
  settings: backupSettingsSchema.nullable(),
  state: z.enum(['off', 'awaiting-runner', 'invalid']),
  message: z.string(),
}).strict();

