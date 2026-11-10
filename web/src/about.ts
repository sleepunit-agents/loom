// Chat about this (t-2034, t-2035; docs/specs/comms.md, "Chat about this"): any loom item can start a Comms thread with
// what it's about attached. An item says what it is with `data-about` (aboutAttr): the desktop's right-click offers
// "Chat about this" for it, and a window's own menu offers it for the page it shows (aboutPage). Either way the request
// is one event, `loom-chat-about`, that App answers with the sheet (chat-about.tsx, its own chunk). This file is on the
// first page, so it stays this small.

/** What it's about: the item's ref or its page (path without the leading slash), the label as shown, and the agent the
 * item names (whose job, whose ask), if any. Who it goes to is the server's call (/comms/route), never this. */
export type About = { ref?: string; page?: string; label: string; agent?: string };

export const CHAT_ABOUT = 'loom-chat-about';

export function chatAbout(a: About): void {
  dispatchEvent(new CustomEvent<About & { seen: string }>(CHAT_ABOUT, { detail: { ...a, seen: new Date().toISOString() } }));
}

/** The attribute a row puts on itself to be chatted about. */
export const aboutAttr = (a: About) => ({ 'data-about': JSON.stringify(a) });

/** A row's `data-about`, read back: only what an About can hold, or null. */
export function aboutOf(el: Element | null): About | null {
  const raw = el?.getAttribute('data-about');
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    const s = (k: string) => (typeof o[k] === 'string' && o[k] ? { [k]: o[k] as string } : {});
    return typeof o.label === 'string' && o.label && (o.ref || o.page) ? { label: o.label, ...s('ref'), ...s('page'), ...s('agent') } : null;
  } catch { return null; }
}

/** A loom page as an item: its ref where loom has one for that page, its agent where the page is an agent's. Only an
 * item's page (a task, a person, an agent, a piece's own page under its home): an app's list (the Inbox, People, a
 * piece's home) isn't something to chat about, and Comms is already a chat. */
export function aboutPage(url: string, label: string): About | null {
  const path = url.replace(/^\/+/, '').replace(/[?#].*$/, '').replace(/\/+$/, '');
  const parts = path.split('/');
  if (parts.length < 2 || parts[0] === 'comms' || (parts[0] === 'p' && parts.length < 3)) return null;
  const task = /^p\/[a-z0-9-]+\/task\/(t-\d+)$/.exec(path)?.[1];
  const cv = /^(?:a\/([a-z][a-z0-9-]*)\/)?conversation\/(cv-[0-9a-f]{12})$/.exec(path);
  const slug = /^(knowledge|projects|people)\/([a-z0-9][a-z0-9-]*)$/.exec(path);
  const agent = /^a\/([a-z][a-z0-9-]*)(?:\/|$)/.exec(path)?.[1];
  const ref = task ?? cv?.[2] ?? (slug ? `${{ knowledge: 'knowledge', projects: 'project', people: 'person' }[slug[1]]}:${slug[2]}` : undefined);
  return { label: label.slice(0, 120), page: path, ...(ref ? { ref } : {}), ...(agent ? { agent } : {}) };
}
