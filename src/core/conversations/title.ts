import {z} from 'zod';
/** Stored titles have at most sixty characters, including astral characters. */
export const threadTitle=z.string().trim().min(1).max(120).refine(value=>[...value].length<=60,'Thread title must be 1–60 characters');
