import { describe, expect, it } from 'vitest';
import { evidence, readReview } from './evidence';
const note = (seq: number, text: string) => ({ seq, text, at: '2026-01-01', actor: 'art' });
describe('evidence from visible notes', () => {
  it('follows new observations at arbitrary positions and preserves the words that qualify the statistic', () => {
    const earlier = note(12, 'Sample: 5% of requests (1/20) failed.');
    const update = note(37, 'Follow-up: 2% failed (1/50) on retry.');
    expect(evidence([earlier, update]).measurement).toMatchObject({
      note: update,
      denominator: '50',
      text: update.text,
    });
    expect(evidence([note(4, 'Backup 12/30 created.')]).measurement).toBeUndefined();
  });
  it('accepts a review only for this evidence revision with exact visible citations', () => {
    const source = note(21, 'Verified that the new check passed.');
    const review = {
      ticket: 't-fixture',
      through: 21,
      question: 'What remains?',
      findings: [{ seq: 21, quote: 'the new check passed' }],
    };
    const parse = (value: object, notes = [source]) => readReview(JSON.stringify(value), 't-fixture', notes);
    expect(parse(review)?.findings[0].note).toBe(source);
    expect(parse({ ...review, ticket: 'other' })).toBeNull();
    expect(parse({ ...review, findings: [{ seq: 21, quote: 'an invented result' }] })).toBeNull();
    expect(parse(review, [source, note(22, 'Superseded.')])).toBeNull();
  });
});
