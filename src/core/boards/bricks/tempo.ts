import { z } from 'zod';
import { brick, none, ref } from './kit.js';

// Tempo's list for one agent, as the desktop's Tempo app lists it under "Whose", with the desktop's Create trigger
// form above it (pieces/tempo/create.tsx), sent as the desktop sends it: tempo.set with what was typed. What can be
// done to a trigger that exists is in its own `trigger` brick. The board is told `create` and nothing typed.
export default brick({ name: 'tempo', big: true, flags: ['a firing failed'],
  shows: "An agent's Tempo triggers (its routines): each one's name, what kind it is, when or on what it fires, its state, its next and last firing and what the last came to, each a chip that places its trigger brick. When big, also the day's recorded firings, and the desktop's form to create a trigger (for this agent unless the member changes it).",
  params: z.object({ agent: ref }).strict(), references: { agent: 'agent' },
  actions: { create: { operation: 'tempo.set', detail: none } } });
