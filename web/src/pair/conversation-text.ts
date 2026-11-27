// Older context clients stored the routing envelope and agent instructions in the message itself.
export function conversationText(kind: string, words: string): string {
  if (kind === 'message') {
    const body = words.replace(/^\[(?:Loom context|Ticket workspace|Project workspace|Entity workspace) · [^\r\n]+\]\r?\n/, '');
    if (body === words || !words.startsWith('[Loom context · ')) return body;
    const split = body.match(/^Prepare a split proposal [^\n]+\. Leave all tickets untouched\.\r?\nRequest: ([\s\S]*)$/);
    if (split) return split[1];
    const layout = body.match(/^Interpret this workspace request: ("(?:\\.|[^"\\])*")\. Current modules: /);
    if (layout) {
      try { return JSON.parse(layout[1]); } catch { return body; }
    }
    const review = body.match(/^Review the decision evidence for (\S+) through note \d+\. Read the current ticket and comments in Loom\./);
    if (review) return 'Review the decision evidence for ' + review[1] + '.';
    return body;
  }
  if (kind !== 'reply') return words;
  function summarize(json: string) {
    try {
      const v = JSON.parse(json);
      if (typeof v?.proposal === 'string' && Array.isArray(v.drafts) && v.drafts.length === 2 &&
          v.drafts.every((d: {title?: string}) => typeof d?.title === 'string'))
        return 'Proposed child tickets\n' + v.drafts.map((d: {title: string}) => '- ' + d.title).join('\n');
      if (typeof v?.view === 'string' && Array.isArray(v.add) && Array.isArray(v.remove) &&
          [...v.add, ...v.remove].every(x => typeof x === 'string'))
        return [v.add.length && 'Add ' + v.add.join(', '), v.remove.length && 'Remove ' + v.remove.join(', ')].filter(Boolean).join('\n') || 'No layout changes proposed.';
      if (typeof v?.ticket === 'string' && typeof v.question === 'string' && Array.isArray(v.findings) &&
          v.findings.every((f: {quote?: string; seq?: number}) => typeof f?.quote === 'string' && Number.isInteger(f.seq)))
        return [v.question, ...v.findings.map((f: {quote: string; seq: number}) => '> ' + f.quote + ' (note ' + f.seq + ')')].join('\n\n');
    } catch { /* Keep ordinary replies and code samples verbatim. */ }
  }
  if (words.trimStart().startsWith('{')) return summarize(words) ?? words;
  return words.replace(/^`{3}(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n`{3}[ \t]*$/gim,
    (block, json: string) => summarize(json) ?? block);
}
