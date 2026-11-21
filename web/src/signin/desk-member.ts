import { createContext } from 'react';

/** The member confirmed by the mounted desk's sign-in gate. */
export const DeskMember = createContext<string | undefined>(undefined);
