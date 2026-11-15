/** Effective private-word deadline after the caller validates retention policy. */
export function wordsDeadline(message: { keepUntil: string | null; at: string }, days: number): number {
  return Math.min(Date.parse(message.keepUntil ?? ''), Date.parse(message.at) + days * 86400000);
}
