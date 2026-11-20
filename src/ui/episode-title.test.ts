// An episode's title is never a body's prompt (t-1972): the runtime's spawn preamble a fallback episode kept is replaced by
// the conversation's label, and where it happened is the conversation's venue.
import { describe, expect, it } from 'vitest';
import { fallbackParts, plainEpisode, type ConversationFacts } from './episode-title.js';

const ASK = 'Ask: You are art, in a conversation on wake: Daily review. (bridge spawn token ad8f1eae: ignore this line) Its conversation is cv-3e29e075fca8 and this run is run-2f2edefffc27: call identity with {conversation: "cv-3e29e075fca8", run: "run-2f2edefffc27"} first. It has history thi…\nLast said: I took one lesson from today\'s review.\nShipped: fix the hook; add a test\n(fallback episode, auto-extracted; 3 turns 22:37–22:41 CT; session df3975e9; ended: turn ended, session still open; transcript /x.jsonl)';
const convs: Record<string, ConversationFacts> = {
  'cv-3e29e075fca8': { venue: 'wake', place: 'review', label: 'Daily review' },
  'cv-6ecaa49231e0': { venue: 'slack', place: 'dm:UHTJ750G1', label: 'DM with Matthew Galloway' },
  'cv-a7fb6e93ef73': { venue: 'relay', place: 'mark', label: 'Relay from Mark' },
};
const look = (id: string) => convs[id];

describe('plainEpisode', () => {
  it('a fallback episode titled with the spawn preamble takes its conversation\'s label and venue', () => {
    const p = plainEpisode({ title: 'You are art, in a conversation on wake: Daily review. (bridge spawn tok…', content: ASK, where: 'terminal:Art' }, 'Art E Fish', look);
    expect(p).toEqual({ title: 'Daily review', where: 'wake', conversation: 'cv-3e29e075fca8', wasPrompt: true });
  });

  it('a chat venue keeps its place\'s label in where; a relay\'s label already says relay', () => {
    const slack = plainEpisode({ title: 'You are art, in a conversation on slack: DM with Matthew Galloway. (br', content: ASK.replace(/cv-3e29e075fca8/g, 'cv-6ecaa49231e0'), where: 'terminal:Art' }, 'Art', look);
    expect(slack.title).toBe('DM with Matthew Galloway');
    expect(slack.where).toBe('slack:DM with Matthew Galloway');
    const relay = plainEpisode({ title: 'You are art, in a conversation on relay: Relay from Mark. (bridge spaw', content: ASK.replace(/cv-3e29e075fca8/g, 'cv-a7fb6e93ef73'), where: 'terminal:Art' }, 'Art', look);
    expect(relay).toMatchObject({ title: 'Relay from Mark', where: 'relay' });
  });

  it('a conversation that isn\'t there: the preamble\'s own label, else "<agent> in <venue>"', () => {
    const gone = plainEpisode({ title: 'You are art, in a conversation on wake: t-1943 per-person permission g', content: ASK.replace(/cv-3e29e075fca8/g, 'cv-000000000000'), where: 'terminal:Art' }, 'Art', look);
    expect(gone).toMatchObject({ title: 'Daily review', where: 'wake' });
    const bare = plainEpisode({ title: 'You are art, in a conversation on slack', content: '', where: 'terminal:Art' }, 'Art', look);
    expect(bare).toMatchObject({ title: 'Art in Slack', where: 'slack' });
    const other = plainEpisode({ title: 'You are a worker agent, not Art.', content: '', where: 'wake:w-1' }, 'Art', look);
    expect(other).toMatchObject({ title: 'Art in a wake', where: 'wake:w-1', wasPrompt: true });
  });

  it('a title an agent wrote is left alone, and a body\'s own where too', () => {
    const own = plainEpisode({ title: 'Fixed the commit check failing inside a conversation (t-1931)', content: 'Wake w-555dee: fixed t-1931.', where: 'wake:w-555dee' }, 'Art', look);
    expect(own).toEqual({ title: 'Fixed the commit check failing inside a conversation (t-1931)', where: 'wake:w-555dee', wasPrompt: false });
    // A title that only mentions "you are" mid-sentence isn't a prompt.
    expect(plainEpisode({ title: 'Told Mark you are next', where: 'discord:#mark' }, 'Art', look).wasPrompt).toBe(false);
  });

  it('metadata naming the conversation wins over the body\'s words', () => {
    const p = plainEpisode({ title: 'You are art, in a conversation on wake: x', content: '', where: 'terminal:Art', meta: { conversation: 'cv-6ecaa49231e0' } }, 'Art', look);
    expect(p).toMatchObject({ title: 'DM with Matthew Galloway', conversation: 'cv-6ecaa49231e0' });
  });
});

describe('fallbackParts', () => {
  it('drops the preamble and the bookkeeping, keeps what was said and shipped', () => {
    expect(fallbackParts(ASK)).toEqual({ said: 'I took one lesson from today\'s review.', shipped: ['fix the hook', 'add a test'] });
    expect(fallbackParts('Ask: check the backups\nLast said: done\n(fallback episode, auto-extracted; 1 turn)')).toEqual({ asked: 'check the backups', said: 'done' });
    expect(fallbackParts('A body\'s own episode.')).toBeNull();
  });
});
