/** An agent's face, as data: its state, its shape and its eyes (face-data.json holds the shapes). Types only. */
export type FaceState = 'idle' | 'thinking' | 'working' | 'needs-input' | 'complete' | 'error' | 'talking';
export type FaceShape = 'pebble' | 'trefoil' | 'clover' | 'drop';
export type FaceEyes = 'dot' | 'oval';
