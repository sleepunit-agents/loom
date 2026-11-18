import { z } from 'zod';

/** How much incoming attachment data one body may materialize across its messages. */
export const HANDED_FILE_BYTES = 8 * 1024 * 1024;
export const BODY_ATTACHMENTS = 10;
export const BODY_ATTACHMENT_BYTES = 32 * 1024 * 1024;

/** Only counts and outcomes enter a write receipt. A private filename stays in its message. */
export const discordFileOutcome = z.object({
  state: z.enum(['saved', 'absent', 'changed', 'unavailable', 'limit', 'too-large']),
  count: z.int().min(0).max(BODY_ATTACHMENTS),
  bytes: z.int().min(0).max(BODY_ATTACHMENT_BYTES),
}).strict();
export type DiscordFileOutcome = z.infer<typeof discordFileOutcome>;
