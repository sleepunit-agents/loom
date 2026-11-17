import { expect, it } from 'vitest';
import { turnsOf, workerTurns } from './worker-turns.js';

const never = () => new AbortController().signal;
const settle = async () => { for (let turn = 0; turn < 10; turn++) await Promise.resolve(); };
/** Take a turn and say, at any moment, whether it has been given. */
function asking(turns: ReturnType<typeof workerTurns>, keys: string[], signal = never()) {
  const state = { given: false, refused: false, release: () => {} };
  void turns.take(keys, signal).then(release => { state.given = true; state.release = release; }, () => { state.refused = true; });
  return state;
}

it('names what a job\'s body needs to itself: its account, and each port it publishes whatever the address', () => {
  expect(turnsOf({ account: 'a', harness: 'claude' })).toEqual(['account:claude:a']);
  // One account under two harnesses is two sign-ins: each has its own turn.
  expect(turnsOf({ account: 'a', harness: 'codex' })).toEqual(['account:codex:a']);
  expect(turnsOf({ account: 'a', harness: 'claude', run: { gpu: false, nestedContainers: false, ports: [{ address: '127.0.0.1', port: 8080 }, { address: '::1', port: 8080 }, { address: '0.0.0.0', port: 9000 }] } }))
    .toEqual(['account:claude:a', 'port:8080', 'port:9000']);
});
it('gives one account to one job at a time, and to the next when the first gives it up', async () => {
  const turns = workerTurns({ accounts: 1 }), first = asking(turns, ['account:a']), second = asking(turns, ['account:a']), other = asking(turns, ['account:b']);
  await settle();
  expect([first.given, second.given, other.given]).toEqual([true, false, true]);
  first.release(); await settle(); expect(second.given).toBe(true);
  // Giving up twice gives nothing away that is somebody else's by then.
  const third = asking(turns, ['account:a']); first.release(); await settle(); expect(third.given).toBe(false);
  second.release(); await settle(); expect(third.given).toBe(true);
});
it('lets as many bodies run on one account as it is told, and makes the next wait; a port is always one body\'s', async () => {
  const turns = workerTurns({ accounts: 2 });
  const one = asking(turns, ['account:a']), two = asking(turns, ['account:a']), three = asking(turns, ['account:a']), other = asking(turns, ['account:b']);
  await settle(); expect([one.given, two.given, three.given, other.given]).toEqual([true, true, false, true]);
  two.release(); await settle(); expect(three.given).toBe(true);
  // Giving up twice frees one place, not two.
  two.release(); const four = asking(turns, ['account:a']); await settle(); expect(four.given).toBe(false);
  one.release(); await settle(); expect(four.given).toBe(true);
  // Two jobs on one account with room for both still cannot publish one port together.
  const wide = workerTurns({ accounts: 4 }), first = asking(wide, ['account:a', 'port:8080']), second = asking(wide, ['account:a', 'port:8080']), third = asking(wide, ['account:a']);
  await settle(); expect([first.given, second.given, third.given]).toEqual([true, false, false]);
  first.release(); await settle(); expect([second.given, third.given]).toEqual([true, true]);
  // The number is a whole one of at least 1.
  for (const accounts of [0, -1, 1.5, Number.NaN]) expect(() => workerTurns({ accounts })).toThrow('Invalid account slots');
});
it('serves in the order asked, and never lets a later job in front of an earlier one that wants the same thing', async () => {
  const turns = workerTurns({ accounts: 1 }), holder = asking(turns, ['account:a']);
  // Wants two things, one of them held. A later job wants only the free one: it waits behind.
  const both = asking(turns, ['account:a', 'port:8080']), later = asking(turns, ['port:8080']), apart = asking(turns, ['port:9000']);
  await settle(); expect([both.given, later.given, apart.given]).toEqual([false, false, true]);
  holder.release(); await settle(); expect([both.given, later.given]).toEqual([true, false]);
  both.release(); await settle(); expect(later.given).toBe(true);
});
it('takes everything at once or nothing, so two jobs cannot hold half of what each other needs', async () => {
  const turns = workerTurns({ accounts: 1 }), one = asking(turns, ['account:a', 'port:1']), two = asking(turns, ['port:1', 'account:a']);
  await settle(); expect([one.given, two.given]).toEqual([true, false]);
  one.release(); await settle(); expect(two.given).toBe(true);
});
it('lets a job that is stopped leave the wait, and lets those behind it move up', async () => {
  const turns = workerTurns({ accounts: 1 }), abort = new AbortController(), holder = asking(turns, ['account:a']);
  const stopped = asking(turns, ['account:a', 'port:1'], abort.signal), behind = asking(turns, ['port:1']);
  await settle(); expect([stopped.given, behind.given]).toEqual([false, false]);
  abort.abort(); await settle();
  expect([stopped.refused, stopped.given, behind.given]).toEqual([true, false, true]);
  // It never held anything: the account goes to the next that asks once its holder is done.
  holder.release(); const next = asking(turns, ['account:a']); await settle(); expect(next.given).toBe(true);
  // A job already cancelled is not put in the line at all.
  const dead = new AbortController(); dead.abort();
  await expect(turns.take(['account:z'], dead.signal)).rejects.toThrow('Worker turn cancelled');
  const free = asking(turns, ['account:z']); await settle(); expect(free.given).toBe(true);
});
it('gives each harness its own number of bodies on one account, and holds one harness\'s bodies apart from another\'s', async () => {
  const turns = workerTurns({ accounts: harness => harness === 'codex' ? 1 : 2 });
  const key = (harness: string, account = 'a') => turnsOf({ account, harness });
  const codex = [asking(turns, key('codex')), asking(turns, key('codex'))], claude = [asking(turns, key('claude')), asking(turns, key('claude')), asking(turns, key('claude'))];
  const elsewhere = asking(turns, key('codex', 'b'));
  await settle();
  // One Codex body on the account at a time, two of Claude Code, and neither waits for the other: they share no sign-in.
  expect(codex.map(one => one.given)).toEqual([true, false]); expect(claude.map(one => one.given)).toEqual([true, true, false]); expect(elsewhere.given).toBe(true);
  codex[0].release(); await settle(); expect(codex[1].given).toBe(true); expect(claude[2].given).toBe(false);
  claude[0].release(); await settle(); expect(claude[2].given).toBe(true);
  // A number that is none, for the harness asked about, is refused when it is asked.
  const broken = workerTurns({ accounts: () => 0 });
  await expect(broken.take(key('claude'), never())).rejects.toThrow('Invalid account slots');
});

