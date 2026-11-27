import { z } from 'zod';
import { brick, none } from './kit.js';

// A reply that did not go out is released or dismissed after asking: a release sends words outside the household
// and neither can be undone. Its words are drawn from loom's read and are never told to the board. A connection,
// a channel rule and a person link are changed by a proposal the agent files, as on the desktop.
export default brick({ name: 'bridges', big: true, flags: ['held send'],
  shows: 'The household\'s bridges to Discord and Slack as the member may read them: the replies waiting for a person to release or dismiss them, and for a household owner the connections with their state and last day\'s activity, the channel rules and the links between outside users and members. When big the member can release or dismiss a waiting reply, after being asked.',
  params: z.object({}).strict(), references: {},
  actions: {
    release: { operation: 'bridges.command', detail: none },
    dismiss: { operation: 'bridges.command', detail: none },
  } });
