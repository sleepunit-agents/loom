import { DAY_MS } from '../day.js';
import { ageLimit } from './retention.js';
import {handoffExpiries} from './handoff-words.js';
import {privateInboxExpiries} from './private-inbox-words.js';
import {oldestPrivateBridgeWords} from './private-bridge-words.js';
import {oldestConversationSession} from './sessions.js';
/** One owned timer for ciphertext retention and daily wordless-history rollup. */
import { isNotNull } from 'drizzle-orm';
import type { Clock } from '../clock.js';
import type { DataDatabase } from '../data/database.js';
import type { DataWrites } from '../data/writes.js';
import { messages } from '../data/schema.js';
import type { CommsMessages } from './messages.js';
import { ConversationHistory } from './history.js';
import { commsKeepDays } from '../data/comms-days.js';
export function conversationLifetime(db: DataDatabase, clock: Clock, service: CommsMessages, writes: DataWrites, reportError: (error: unknown) => void) {
  const history = new ConversationHistory(db, () => new Date(clock.now()).toISOString());
  let closed = false, cancel: (() => void) | undefined;
  const report = (error: unknown) => { try { reportError(error); } catch { /* Reporting cannot revive a closed lifecycle. */ } };
  const sweep = () => {
    const result = writes.run(() => { service.expire(); history.rollup(); });
    for (const error of result.notificationErrors) report(error);
  };
  const schedule = () => {
    cancel?.(); cancel = undefined;
    if (closed) return;
    const now = clock.now(), days = commsKeepDays(db);
    let next = Date.parse(new Date(now + DAY_MS).toISOString().slice(0,10) + 'T00:00:00.000Z');
    for (const row of db.select({ at: messages.at, until: messages.keepUntil }).from(messages).where(isNotNull(messages.words)).all()) {
      const householdEnd = ageLimit(Date.parse(row.at), days), storedEnd = Date.parse(row.until ?? '');
      if (Number.isFinite(householdEnd)) next = Math.min(next, householdEnd);
      if (Number.isFinite(storedEnd)) next = Math.min(next, storedEnd);
    }
    for(const item of handoffExpiries(db,days))next=Math.min(next,item.until);
    for(const item of privateInboxExpiries(db,days))next=Math.min(next,item.until);
    const bridgeWords=oldestPrivateBridgeWords(db);if(bridgeWords!==undefined)next=Math.min(next,ageLimit(bridgeWords,days));
    const session=oldestConversationSession(db);if(session!==undefined)next=Math.min(next,ageLimit(session,days));
    cancel = clock.at(Math.max(now, next), () => {
      cancel = undefined; if (closed) return;
      try { sweep(); schedule(); }
      catch (error) { report(error); if (!closed) cancel = clock.at(clock.now() + 60000, schedule); }
    });
  };
  // Clean already-expired bytes before admitting callers. Services and receipts
  // use the same writer; the observer sees only completed outer transactions.
  sweep();
  const stop = writes.observe(schedule); schedule();
  return { close() { if (closed) return; closed = true; stop(); cancel?.(); cancel = undefined; } };
}
