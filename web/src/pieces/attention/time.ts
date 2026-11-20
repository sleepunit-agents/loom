/** Shared record timestamps stay independent of any screen module. */
export const stamp = (at: number) => `${new Date(at).toLocaleString('en-US', { timeZone:'America/Chicago' })} CT`;
