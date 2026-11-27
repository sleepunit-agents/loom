/** What the `tempo` and `trigger` bricks share: Tempo's words for a trigger as the desktop's Tempo app says them
 * (pieces/tempo/model.ts), the household's clock for a time, and which job states are a failure. No component. */
import { calendarState, stateLabels, type AgentPause, type Trigger } from '../pieces/tempo/model';
import type { Tone } from './brick-kit';

/** A time on the household's clock, as Tempo's reader writes one. */
export const clock = (zone: string) => new Intl.DateTimeFormat(undefined, { timeZone: zone, dateStyle: 'medium', timeStyle: 'short' });
/** Tempo's own word for where a trigger stands: Standing, Due, Firing, Held, Spent, Stopped, Failed. */
export const stateWord = (trigger: Trigger, pauses: readonly AgentPause[]) => stateLabels[calendarState(trigger, pauses)];
/** A delivery's job that did not finish its work, as the calendar reads one (src/core/tempo/deliveries.ts). */
export const jobFailed = (state: string | null | undefined) => state === 'failed' || state === 'lost';
/** The tone of each of Tempo's states: firing is work in hand, due and held wait, a failure is bad, the rest are quiet. */
const tones: Record<keyof typeof stateLabels, Tone> = { standing: 'neutral', due: 'waiting', firing: 'working', held: 'waiting', spent: 'muted', stopped: 'muted', failed: 'bad' };
export const stateTone = (trigger: Trigger, pauses: readonly AgentPause[]): Tone => tones[calendarState(trigger, pauses)];
