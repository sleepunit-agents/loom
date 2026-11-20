import { invalid, grantOf, vouchOf, resetOf, hostOf, writeoffOf } from './targets.js';
import { type Approval, forOf } from './model.js';
export const plain = (text: string, n = 1e6) => text.normalize('NFKC').replace(/[\p{C}\p{Z}<>\[\]{}]/gu,' ').replace(/ +/g,' ').trim().slice(0,n);
const names = (slug: string) => slug.split('-').map(w => w[0]?.toUpperCase()+w.slice(1)).join(' ');
/** Legacy principal wording used in spend refusals. */
export function principalWords(p: {for?: string;people?: string[]}, owner = 'the owner'): string {
  const who = forOf(p);
  if (who === 'owner') return owner;
  if (who !== '?') return names(who).slice(0,40);
  const people = (p.people ?? []).map(p=>names(p).slice(0,40));
  if (people.length > 3) return `${people.slice(0,2).join(', ')} and ${people.length-2} others`;
  if (people.length > 1) return `${people.slice(0,-1).join(', ')} and ${people.at(-1)}`;
  return "someone loom can't name";
}
export function checkPlain(words: Record<string,string>) {
  for (const [field,text] of Object.entries(words)) {
    const max = field === 'ask' ? 140 : field === 'why' ? 240 : 200;
    if (text.length > max || /[\r\n]/.test(text)) invalid(`--${field.replace('_','-')} is one line, at most ${max} characters`);
    const ids = /\b(?:a-[0-9a-f]{8}|cv-[0-9a-f]{6,}|dg-[0-9a-f]{6,}|w-[0-9a-f]{6,}|r-\d{3,}|h-\d+|round\s+\d+|nudge[- ]watch|chain[- ]check|local[- ]wake|plan[- ]night|wake (?:in|at|park|relay|list))\b|(?<![\w-])(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{6,40}\b|(?<![\w-])[0-9a-f]{41,}\b/i;
    // Site codes are case sensitive in the old lint.
    if (ids.test(text) || /\b[A-Z]{1,2}\d{2,4}\b/.test(text) || (field === 'ask' && (/\bt-\d+\b|(?<![\w./-])(?:[\w.-]+\/)?[\w.-]+#\d+\b/.test(text) || /^[\w.-]+:\s/.test(text)))) invalid(`--${field.replace('_','-')} must say it in plain words: no ids, hashes, round numbers or lane words`);
  }
}
export function ownerWords(a: Approval) {
  const g = grantOf(a.target), v = vouchOf(a.target), r = resetOf(a.target), h = hostOf(a.target);
  if (a.kind === 'grant' && g) return `Give ${names(g.agent)} access to ${names(g.piece)}${g.paths.includes('*') ? '' : `, for ${g.paths.join(', ')}`}?`;
  if (a.kind === 'vouch-wake' && v) return v.ids.length === 1 ? 'Count this scheduled job as your work?' : `Count these ${v.ids.length} scheduled jobs as your work?`;
  if (a.kind === 'principal-reset' && r) return 'Count this conversation as your work from now on?';
  if (a.kind === 'box-write-off' && writeoffOf(a.target)) return 'Move this work off the silent box?';
  if (a.kind === 'host' && h) {
    const unit = h.arg.replace(/\.service$/,'');
    return ({ 'unit-status': `Read the status of ${unit} on loom's machine?`, journal: `Read ${unit}'s log on loom's machine?`, 'art-chain-check': "Run Art's wake-chain check on loom's machine?", read: `Read ${h.arg} from the runtime's logs on loom's machine?`, 'deploy-loom': `Deploy loom's latest build on loom's machine (${h.arg})?`, 'pieces-update': `Update loom's ${h.arg} piece on loom's machine?`, restart: `Restart ${unit} on loom's machine?` } as Record<string,string>)[h.verb];
  }
}
/** These promises belong to the action, never to the body asking for it. */
export function cardWords(a: Approval) {
  const outcomes: Record<string, [string,string]> = {
    grant: ['I give the access shown below.', 'I leave access unchanged.'],
    'vouch-wake': ['I count the listed scheduled jobs as your work.', 'I leave those jobs waiting.'],
    'principal-reset': ['I count this conversation as your work from now on.', 'I leave the conversation unchanged.'],
    'box-write-off': ['I move the covered work off this silent box.', 'I leave the work on that box.'],
  };
  const outcome = outcomes[a.kind];
  return { title:headline(a), ...(outcome ? {if_yes:outcome[0],if_no:outcome[1]} : {}) };
}
export function headline(a: Approval) {
  const owner = ownerWords(a); if (owner) return owner;
  const body = a.ask || `(no plain question given) ${a.what}`;
  if (forOf(a) === 'owner') return body;
  const who = forOf(a) === '?' ? a.people?.map(names).join(' and ') || "someone loom can't name" : names(forOf(a));
  return `For ${who}: ${body}`;
}
