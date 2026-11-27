import { z } from 'zod';
import { triggerRef } from '../refs.js';
import { brick, none } from './kit.js';

// The desktop's trigger reader and its five buttons. Pause and resume are of the trigger's agent, as there: Tempo
// holds every trigger of a paused agent. Which trigger and which agent are the record's; nothing is told.
export default brick({ name: 'trigger', big: true, flags: ['failed'],
  shows: 'One Tempo trigger in full: when it fires or what it watches, its words, how long it lasts, what it targets, who set it, its recent runs (each a session chip where it has a conversation), its lessons where the member may read them and, when big, its recent history. The member can run it now, stop or start it, and pause or resume its agent.',
  params: z.object({ trigger: z.string().regex(triggerRef) }).strict(), references: { trigger: 'trigger' }, linkKey: 'trigger',
  actions: {
    runNow: { operation: 'tempo.runNow', detail: none }, stop: { operation: 'tempo.stop', detail: none },
    start: { operation: 'tempo.start', detail: none }, pause: { operation: 'tempo.pause', detail: none },
    resume: { operation: 'tempo.resume', detail: none },
  } });
