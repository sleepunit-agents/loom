import { brick, none } from './kit.js';

// The member's own: it names no record, so it takes no parameter, and every action's detail is empty. A passkey's
// name, a browser's name and a sign-in link never reach a board. Adding a passkey, making a sign-in link and
// signing this device out go to the sign-in door, which is no operation, so the board is not told of them.
export default brick({ name: 'account', big: true,
  shows: "The signed-in member's own account: their passkeys, the browsers signed in as them and the devices enrolled for notifications. Big, each can be removed after asking, a passkey added, and another device signed in by a one-time link.",
  params: none, references: {},
  actions: { removePasskey: { operation: 'account.removePasskey', detail: none }, revokeSession: { operation: 'account.revokeSession', detail: none },
    removeDevice: { operation: 'notifications.removeDevice', detail: none }, enableNotifications: { operation: 'notifications.subscribe', detail: none } } });
