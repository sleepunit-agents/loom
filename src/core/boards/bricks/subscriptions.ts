import { z } from 'zod';
import { brick, none } from './kit.js';

// What the member searches for, the account opened and a new subscription's label are typed inside the drawn brick
// and are no parameter. A sign-in is asked for here; the provider's instructions arrive in the Inbox, as on the desktop.
export default brick({ name: 'subscriptions', big: true, flags: ['sign-in needed'],
  shows: 'The household\'s model accounts as the member may read them, by service: each one\'s label and how full it is, and for an account the member may read in full its owner, usage windows, when they reset, whether it has room, and where it is signed in or needs a sign-in. When big the member opens an account for its weekly usage by agent, trigger or conversation, asks for a sign-in on a machine, sees each agent\'s models in order, and adds a subscription.',
  params: z.object({}).strict(), references: {},
  actions: {
    signIn: { operation: 'runtime.accountSignIn', detail: none },
    create: { operation: 'runtime.accountCreate', detail: none },
  } });
