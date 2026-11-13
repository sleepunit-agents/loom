import { z } from 'zod';
export const secretName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
export const secretAgent = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(100);

/** A house's words are displayed as one plain line; they never decide access. */
export const requestReason = z.string().max(2000).transform(text => text.normalize('NFKC')
  .replace(/[\p{C}\p{Z}<>[\]{}]/gu, ' ').replace(/ +/g, ' ').trim().slice(0, 300))
  .pipe(z.string().min(1));
