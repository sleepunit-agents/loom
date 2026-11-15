/** Selected private-word deadlines travel with the server execution context,
 * without adding authority or retention metadata to the public query result. */
const deadlines = new WeakMap<object, number>();
export function clearReadDeadline(context: unknown): void {
  if (context && typeof context === 'object') deadlines.delete(context);
}
export function keepReadUntil(context: unknown, until: number): void {
  if (!context || typeof context !== 'object') return;
  const deadline = Number.isFinite(until) ? until : -Infinity;
  deadlines.set(context, Math.min(deadlines.get(context) ?? Infinity, deadline));
}
export function readDeadline(context: unknown): number | undefined {
  return context && typeof context === 'object' ? deadlines.get(context) : undefined;
}
export function readRetained(context: unknown, now: number): boolean {
  const deadline = readDeadline(context); return deadline === undefined || now < deadline;
}
