/** Appearance's choices, as words: what each of a person's own settings is called and may be set to. The desktop's
 * Appearance app and the boards page's `appearance` brick both draw from these; the looks themselves are in
 * ../../look.ts (LOOKS). The server holds the values it takes (src/shared-preferences.ts). No component, no sheet. */
export const FOLLOW = [{ value: 'follow', label: 'Follow this device' }, { value: 'on', label: 'On' }, { value: 'off', label: 'Off' }] as const;
export const GROUNDS = [{ value: 'depth', label: 'Depth' }, { value: 'contours', label: 'Contours' }, { value: 'wash', label: 'Wash' }] as const;
/** The switches: each one's name, what it does, and what it is until the person chooses. */
export const SWITCHES = {
  pixel: { label: 'Pixel faces', hint: 'Agents with a pixel portrait wear it.', fallback: true },
  sound: { label: 'Sound', hint: 'Short sounds as you use loom.', fallback: false },
  haptics: { label: 'Haptics', hint: 'A small tap you can feel, on a phone.', fallback: true },
  oneWindow: { label: 'One window at a time', hint: 'Show one app at a time. The others stay in the dock.', fallback: false },
  zoom: { label: 'Allow zoom', hint: 'Pinch or double-tap to zoom, on a phone.', fallback: false },
} as const;
export type SwitchKey = keyof typeof SWITCHES;
/** What a failed save says, on the desktop and on a board. */
export const SAVE_UNCONFIRMED = 'Could not confirm the save. Your live choices are still shown.';
