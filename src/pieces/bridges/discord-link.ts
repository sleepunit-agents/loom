/** Whether a link is one of Discord's own for an attachment: on its two file hosts, over https, with no
 * space, control character, bracket or backslash, and of a sane length. The one rule: a link is put in a
 * message's words (normalize.ts) exactly when it is one loom would fetch (discord-files.ts). No imports. */
export const discordFileLink = (value: string): boolean => /^https:\/\/(cdn\.discordapp\.com|media\.discordapp\.net)\/[^\s\u0000-\u001f\u007f[\]\\]{1,2000}$/.test(value);
