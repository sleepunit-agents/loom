import { brick, none } from './kit.js';

// The member's own: no parameter. One action for every choice; the board is told that a choice was saved, not which.
export default brick({ name: 'appearance', big: true,
  shows: "The signed-in member's own Appearance choices, as the desktop keeps them: look, desk background, reduce motion, higher contrast and the switches. Big, each is a row of buttons and a press saves it. On the boards page only reduce motion takes effect; the rest are for the desktop.",
  params: none, references: {}, actions: { set: { operation: 'household.setPreferences', detail: none } } });
