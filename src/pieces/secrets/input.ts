import { z } from 'zod';
export const secretName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
export const secretAgent = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(100);
