/** A calendar day as loom writes one: YYYY-MM-DD. The shape only; whether it is a real day is
 * `validDay` in src/pieces/mind/activity-model.ts. */
export const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A day, in milliseconds. Every length of time counted in days is a multiple of this one number. */
export const DAY_MS = 86_400_000;
