/** What a post's files may be, said once. A file of its own with no imports, so a body can load it to
 * refuse a file before sending it, by the same numbers loom refuses it by (sends.ts). Discord only.
 * (Its one import, file-name.ts, has none of its own.)
 *
 * One request through loom's door carries a post and its files (core/data/door-limit.ts), base64 in JSON,
 * which is what bounds the bytes. */
import { plainFileName } from './file-name.js';
/** The most files one post carries. */
export const SEND_FILES = 4;
/** The most bytes a post's files hold together. */
export const SEND_FILES_BYTES = 600 * 1024;
/** A file's name as it is posted: the last part of what was given, in plain characters. */
export const sendFileName = (name: string): string => plainFileName(name.split(/[\\/]/).pop() ?? '', 100);
