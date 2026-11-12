// The desktop's agents (web/src/desk-agents.tsx deskAgents; docs/specs/agent-desk.md): only the shell's agents (the
// viewer's own), alphabetical by name, each card's facts from Home's page, its unread from the viewer's own Comms
// summary and nothing else.
import { describe, it, expect } from 'vitest';
import { deskAgents, when, type AgentComms, type DeskHomeData } from '../../web/src/desk-agents';
import type { Shell } from '../../web/src/loom';

const agent = (id: string, label: string, asks = 0) => ({ id, label, bg: '#B8A6FF', fg: '#000', href: `/a/${id}`, current: false, asks });
const shell = (agents: ReturnType<typeof agent>[]) => ({ agents } as unknown as Shell);

describe('the desktop\'s agents', () => {
  it('are the shell\'s agents only, alphabetical by name whatever the household\'s order', () => {
    const home: DeskHomeData = { headline: '', needs: 0, cards: [{ id: 'zed', label: 'Zed', bg: '#000', fg: '#fff', state: 'working', doing: [{ text: 'secret work' }] } as never] };
    const a = deskAgents(shell([agent('mark', 'Visual Mark'), agent('art', 'art e fish'), agent('nova', 'Nova')]), home, null);
    expect(a.map((x) => x.id)).toEqual(['art', 'nova', 'mark']);
    // A card Home has for an agent the shell doesn't (not the viewer's) never becomes one.
    expect(JSON.stringify(a)).not.toContain('secret work');
  });

  it('take unread, the first line and the thread to open from the Comms summary, for the agent it names only', () => {
    const comms: Record<string, AgentComms> = {
      art: { agent: 'art', unread: 2, first: { thread: 'th:aaaaaaaaaa', text: 'hello' }, last: { thread: 'th:bbbbbbbbbb', title: 'Backups', at: new Date().toISOString() } },
    };
    const [art, mark] = deskAgents(shell([agent('art', 'Art'), agent('mark', 'Mark')]), null, comms);
    expect(art).toMatchObject({ unread: 2, first: { text: 'hello', href: '/comms/aaaaaaaaaa' }, last: { title: 'Backups', href: '/comms/bbbbbbbbbb' }, open: '/comms/aaaaaaaaaa' });
    expect(mark).toMatchObject({ unread: 0, open: '/comms' });
    expect(mark.first).toBeUndefined();
    // No summary yet (or none at all): nothing unread, Comms to open.
    expect(deskAgents(shell([agent('art', 'Art')]), null, null)[0]).toMatchObject({ unread: 0, open: '/comms' });
  });

  it('say how each is: trouble, then an ask, then work, then quiet; the next wake from the Clock\'s Next', () => {
    const home: DeskHomeData = { headline: '', needs: 1, cards: [
      { id: 'a', label: 'A', bg: '#000', fg: '#fff', state: 'broken', problems: [{ text: 'disk full', tone: 'bad' }] },
      { id: 'b', label: 'B', bg: '#000', fg: '#fff', state: 'working', doing: [{ text: 'on it', href: '/comms/cccccccccc' }] },
      { id: 'c', label: 'C', bg: '#000', fg: '#fff', state: 'working', doing: [{ text: 'busy' }] },
      { id: 'd', label: 'D', bg: '#000', fg: '#fff', state: 'available', readings: [{ label: 'Next', value: 'Sun · 21:00', detail: 'weekly plan' }] },
    ] as never };
    const [a, b, c, d] = deskAgents(shell([agent('a', 'A'), agent('b', 'B', 1), agent('c', 'C'), agent('d', 'D')]), home, null);
    expect([a.status.tone, b.status.tone, c.status.tone, d.status.tone]).toEqual(['bad', 'ask', 'work', 'quiet']);
    expect(a.now).toMatchObject({ text: 'disk full', tone: 'bad' });
    expect(b.now).toEqual({ text: 'on it', href: '/comms/cccccccccc' });
    expect(d.now.text).toBe('Nothing right now');
    expect(d.wake).toBe('Sun · 21:00 · weekly plan');
  });

  it('say when as a card does', () => {
    const now = new Date(2026, 10, 7, 17, 0).getTime();
    expect(when(new Date(2026, 10, 7, 9, 5).toISOString(), now)).toBe('09:05');
    expect(when(new Date(2026, 10, 6, 9, 5).toISOString(), now)).toBe('yesterday');
    expect(when('nonsense', now)).toBe('');
  });
});
