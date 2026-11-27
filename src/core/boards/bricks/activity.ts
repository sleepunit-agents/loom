import { z } from 'zod';
import { brick } from './kit.js';

// Activity's timeline, read-only. The windows Activity reads are three days each; the page keeps the newest `days`.
export default brick({ name: 'activity', big: true,
  shows: "The household's timeline over the last day, 7 days or 30 days: what each agent did and where, newest first, with its tickets and pull requests as chips. When big the member can open an entry to read what was asked, what happened and what was decided.",
  params: z.object({ days: z.union([z.literal(1), z.literal(7), z.literal(30)]).default(1) }).strict(), references: {}, actions: {} });
