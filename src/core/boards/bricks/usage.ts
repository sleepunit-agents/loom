import { z } from 'zod';
import { brick } from './kit.js';

// Job usage, read-only. The conversation whose jobs are listed is picked inside the drawn brick and is no parameter.
export default brick({ name: 'usage', big: true,
  shows: 'Job usage over the last day, 7 days or 30 days, per conversation, most reported tokens first: reported tokens, peak context, jobs and retries, each conversation a session chip. When big the member picks one conversation to read each of its jobs: harness, model, tokens in and out, cache, model and tool calls, context and wall time.',
  params: z.object({ days: z.union([z.literal(1), z.literal(7), z.literal(30)]).default(7) }).strict(), references: {}, actions: {} });
