/** Whether a link is one of Discord's own for an attachment: on its two file hosts, over https, with no
 * space, control character, bracket or backslash, and of a sane length. */
export const discordFileLink = (value: string): boolean => /^https:\/\/(cdn\.discordapp\.com|media\.discordapp\.net)\/[^\s\u0000-\u001f\u007f[\]\\]{1,2000}$/.test(value);

/** The bounded single-line label written by normalizeDiscord, with the optional signed URL used
 * in older transcripts. Both display paths recognize exactly this format. */
const label = /^(\[attachment: ([^\r\n\[\]]{1,200}) \([^\r\n\[\]]{1,100}, (\d{1,16}) bytes\))(?: (https:\/\/[^\s\]]+))?\]$/;
function attachmentLine(line: string): RegExpExecArray | null {
  const match = label.exec(line);
  return match?.[4] && !discordFileLink(match[4]) ? null : match;
}

/** Keep the label, media type and size when projecting a legacy message or historical turn. */
export function discordBodyWords(words: string): string {
  return words.split('\n').map(line => {
    const match = attachmentLine(line);
    return match?.[4] ? match[1] + ']' : line;
  }).join('\n');
}

/** Whole descriptors hint that loom should look up the message and give the original sizes to
 * check any older cached copies. Neither names nor URLs here supply a download address. */
export function discordAttachmentLabels(words: string): {name:string; bytes:number}[] {
  return words.split('\n').flatMap(line => {
    const match = attachmentLine(line);
    return match ? [{name:match[2],bytes:Number(match[3])}] : [];
  });
}
