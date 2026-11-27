import { z } from 'zod';
import { brick, none, ref } from './kit.js';

// Answered from the board with the desktop's own safeguards, from the code the desktop's card runs
// (web/src/pieces/approval-view/answering.ts): who may answer, the reviewed version of a household change, the
// second yes for a dangerous one. A reason for denying goes to approvals.answer and never to the board.
export default brick({ name: 'approval', shows: 'An approval request: what it allows, why, for which agent, its state. A member the household lets answer allows or denies it from the board.',
  params: z.object({ approval: ref }).strict(), references: { approval: 'approval' }, linkKey: 'approval',
  // `always` is the desktop's standing answer for a merge: asked about first, then sent by approvals.always.
  actions: { approve: { operation: 'approvals.answer', detail: none }, refuse: { operation: 'approvals.answer', detail: none },
    always: { operation: 'approvals.always', detail: none } } });
