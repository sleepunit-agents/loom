import { z } from 'zod';
import { isAbsolute } from 'node:path';
const recipient = z.string().max(1000).regex(/^(age1[0-9a-z]{20,}|ssh-(ed25519|rsa) [A-Za-z0-9+/=]{20,}( [^\r\n]{0,100})?)$/);
function targetValid(value: string): boolean {
  if (/[\x00-\x1f\x7f]/.test(value)) return false;
  if (value.startsWith('path:')) return isAbsolute(value.slice(5));
  if (/\s/.test(value)) return false;
  if (!value.startsWith('git:')) return false;
  const url = value.slice(4);
  if (url.startsWith('-')) return false;
  if (url.startsWith('/')) return true;
  if (/^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^\s]+$/.test(url)) return true;
  try {
    const parsed = new URL(url);
    return ['https:', 'ssh:', 'file:'].includes(parsed.protocol) && !parsed.password && !parsed.search && !parsed.hash
      && (parsed.protocol === 'ssh:' || !parsed.username)
      && (parsed.protocol === 'file:' ? !parsed.host && isAbsolute(decodeURIComponent(parsed.pathname)) && !/[\x00-\x1f\x7f]/.test(decodeURIComponent(parsed.pathname)) : !!parsed.host);
  } catch { return false; }
}
export const backupSettingsSchema = z.object({
  target: z.string().min(1).max(4096).refine(targetValid, 'Use a credential-free git URL or an absolute path target'),
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

