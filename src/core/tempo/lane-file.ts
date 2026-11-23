/** Which files of the configured checkout a lane may name: a relative path of plain names. No `.` or `..`,
 * no empty part, no backslash, and no hidden file or directory (`.git`, `.env`): a lane's words are
 * routine files, and whoever may set a trigger must not be able to read the checkout's settings through
 * one. The one rule, asked when a trigger is set (triggers.ts) and again when its file is read
 * (repository.ts). It reads no file itself, so the code that sets triggers imports no file access. */
export const laneFile = (file: string): boolean =>
  !!file && !file.includes('\\') && file.split('/').every(part => !!part && !part.startsWith('.') && !part.includes('\0'));

export const FILE_READER_UNAVAILABLE = 'Loom needs a configured routine repository for file-based wakes. You can supply the instructions as text.';
