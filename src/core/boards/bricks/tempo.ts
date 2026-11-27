import { z } from 'zod';
import { brick, ref } from './kit.js';

// Tempo's list for one agent, as the desktop's Tempo app lists it under "Whose". What can be done to a trigger is in
// its own `trigger` brick.
export default brick({ name: 'tempo', big: true, flags: ['a firing failed'],
  shows: "An agent's Tempo triggers (its routines): each one's name, what kind it is, when or on what it fires, its state, its next and last firing and what the last came to, each a chip that places its trigger brick. When big, also the day's recorded firings.",
  params: z.object({ agent: ref }).strict(), references: { agent: 'agent' },
  actions: {} });
