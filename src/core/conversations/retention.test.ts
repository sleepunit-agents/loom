import { expect, it } from 'vitest';
import { wordsDeadline } from './retention.js';
it('uses the earlier stored or household deadline and fails closed on malformed time', () => {
 const at='2026-11-14T00:00:00Z', day=86400000;
 expect(wordsDeadline({at,keepUntil:'2026-11-14T00:00:01Z'},1)).toBe(Date.parse(at)+1000);
 expect(wordsDeadline({at,keepUntil:'2026-11-28T00:00:00Z'},1)).toBe(Date.parse(at)+day);
 expect(wordsDeadline({at,keepUntil:null},1)).toBeNaN();
});
