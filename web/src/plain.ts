// The Inbox's items in plain words (web/src/inbox.tsx): no React here, so it's tested on its own (src/ui/inbox-plain.test.ts).
/** An item in plain words (Jonathan, 2026-10-29: "Art requested access to a token: github-jbarket-onterris-token"):
 * what it is as a headline, the agent's own why under it, and how it ended in a word. The words as the piece wrote
 * them stay in the drawer. Anything that matches none of these is shown as written. */
export function plain(i: { text: string; outcome?: string; meta?: string }, name: string): { title: string; why?: string; ended?: string } {
  const who = name || 'An agent';
  const said = /^\S+ (asked for|asked:)\s*(.*)$/s.exec(i.text);
  let title = i.text, why: string | undefined = i.outcome ?? i.meta;
  if (said?.[1] === 'asked for') {
    const m = /^([\w.-]+):\s*[“"](.*)[”"]\s*$/s.exec(said[2]);
    if (m) { title = `${who} asked for ${/token|key$/i.test(m[1]) ? 'a token' : 'a secret'}: ${m[1]}`; why = m[2]; }
  } else if (said) {
    const m = /^run on loom's machine:\s*(.*)$/s.exec(said[2]);
    title = m ? `${who} asked to run something on loom's machine` : `${who} asked for your OK`;
    why = (m ? m[1] : said[2]).trim();
  }
  const o = i.outcome ?? '';
  const ended = !o ? undefined : /expired unused/i.test(o) ? 'Expired unused' : /ran out/i.test(o) ? 'Used, ran out'
    : /and used/i.test(o) ? 'Used' : /^denied|refused|declined/i.test(o) ? 'Declined' : /^allowed/i.test(o) ? 'Allowed' : undefined;
  return { title, why, ended };
}
