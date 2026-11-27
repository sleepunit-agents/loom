/** A name shown on one line: a model, a provider, a model account, a sign-in request, a machine.
 * Stated once, so the door that creates a thing and the door that later names it accept the same names. */
import { z } from 'zod';

export const LINE_NAME_MAX = 200;
/** 1 to LINE_NAME_MAX characters, with no space at either end and no line break or NUL in it. */
export const lineName = z.string().min(1).max(LINE_NAME_MAX).refine(value => value === value.trim() && !/[\0\r\n]/.test(value));
/** Has this text a control character in it: a C0 or C1 control (a tab and a line break among them), or a
 * Unicode line or paragraph separator? Text shown on one line, or handed to a program as one value, has none. */
const controls = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/gu;
export const hasControlCharacter = (value: string): boolean => value.search(controls) !== -1;
export const onOneLine = (value: string): string => value.replace(controls, ' ');
/** A machine's name: a line name with no control character of any kind in it (a tab, an escape, a
 * Unicode line or paragraph separator). The door that enrols a machine and the one that renames it both
 * take this, so neither can store a name the other refuses. A name is refused, never trimmed for the
 * caller: what is stored is what was sent. */
export const machineName = lineName.refine(value => !hasControlCharacter(value));

/** A single clean line: text an agent or a page gives that loom later repeats, in its own voice, to a person or to
 * another job (a board's title, a blueprint's name and description, a session step's tool). It holds no control
 * character (Unicode Cc: a line break, a tab, an escape), no format character (Cf: a bidirectional override, a
 * zero-width joiner or space, a soft hyphen) and no line or paragraph separator.
 * Text that breaks the rule is refused, never repaired: what is stored is what was sent. This is the one home of
 * the rule; `cleanLineOf` is for rows stored before it, which are cleaned as they are repeated. */
const unclean = /[\p{Cc}\p{Cf}\u2028\u2029]/u;
export const CLEAN_LINE = 'one line with no control characters and no invisible formatting characters (a line break, a tab, a zero-width or direction mark)';
export const isCleanLine = (value: string): boolean => !unclean.test(value);
export const cleanLineOf = (value: string): string => value.replace(new RegExp(unclean.source, 'gu'), '');
