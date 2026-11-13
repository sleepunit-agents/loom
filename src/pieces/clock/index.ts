import { clockCommands, clockOperationCommands } from './commands.js';
import { command } from './binding.js';
import { registerBuiltinService } from '../../core/services.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { migrate, operation, OperationError, maySee, mayAct, mayCreate, type Db, type Operations, type Live, type Sharing, type Viewer, type Context } from '../../core/index.js';
import { schema } from './schema/001.js';
import { wakes, schedules, wake, schedule, saveWake, saveSchedule, event, paused, active, type Wake, type Work, type Schedule } from './store.js';
import { parseAt, parseIn, nextOccurrence, timesOf, daysOf } from './time.js';
import { stagingRuntime, type Runtime, type StartResult } from './dependencies/runtime.js';
import { deskJobs, agentNext } from './desk.js';
import { unpark } from './unpark.js';
import type { HouseholdAskSource } from '../attention/role.js';
import type { Approvals } from './dependencies/approvals.js';
const day = 86400_000;
const scope = (w: Work, type = 'wake') => ({ type, agent: w.agent, project: w.project, member: w.member });
const text = z.string().min(1).max(100_000);
const workInput = z.object({ agent: text, project: text.optional(), member: text.optional(), prompt: text.optional(), file: text.optional(), note: z.string().max(100_000),
  model: text.optional(), continuation: text.optional(), slot: text.optional(), approval: text.optional(), place: text.optional() });
const idInput = z.object({ id: text });
const startResult = z.discriminatedUnion('state', [
  z.object({ state: z.literal('started'), body: text }),
  z.object({ state: z.literal('not-started'), reason: text, retryAt: z.number().int().safe().optional(), code: z.literal('quota').optional(), retryAfter: z.unknown().optional() }),
  z.object({ state: z.literal('held'), reason: text }),
  z.object({ state: z.literal('uncertain'), reason: text }),
]);
const invalid = (message: string): never => { throw new OperationError('invalid', message); };
function work(input: Work): Work {
  if (!!input.prompt === !!input.file) invalid('Give exactly one prompt or lane file');
  if (input.prompt && /^(?:\/|\.\.?\/|routines\/)/.test(input.prompt)) invalid('Use --file for a lane path');
  if (input.file && (/^(?:\/|[A-Za-z]:)/.test(input.file) || input.file.split('/').includes('..'))) invalid('Lane files must be relative repository paths');
  return input;
}
function calendar<T>(f: () => T): T { try { return f(); } catch (e) { return invalid(e instanceof Error ? e.message : 'Invalid time'); } }
function quotaDue(reset: unknown, now: number): number {
  // A reset must name an instant, never the daemon host's wall timezone.
  const parsed = z.iso.datetime({ offset: true }).safeParse(reset).success ? Date.parse(reset as string) : NaN;
  const when = Number.isFinite(parsed) ? parsed : now + 60 * 60_000;
  return Math.min(Math.max(when + 60_000, now + 15 * 60_000), now + 8 * day);
}
export interface ClockOptions { runtime?: Runtime; approvals?: Approvals; notices?: HouseholdAskSource }
/** Install on the new side only. The composition root must close jobs before its database. */
export function installClock(db: Db, operations: Operations, live: Live, sharing: () => Sharing, options: ClockOptions = {}) {
  registerBuiltinService(operations, 'clock', ['wake', 'schedule', 'clock']);
  migrate(db, 'clock', schema);
  const clock = operations.clock, runtime = options.runtime ?? stagingRuntime();
  let parksChanged = false;
  let closed = false, cancelTimer: (() => void) | undefined;
  const see = (v: Viewer, w: Work, type = 'wake') => maySee(v, scope(w, type), sharing());
  const act = (v: Viewer, w: Work, household = false) => mayAct(v, scope(w), sharing(), household ? 'household' : 'act');
  const create = (v: Viewer, w: Work) => mayCreate(v, scope(w), sharing()) && (v.kind !== 'member' || mayAct(v, scope(w), sharing(), 'give-work'));
  const get = (id: string) => wake(db, id) ?? (() => { throw new OperationError('not-found', 'Wake not found'); })();
  const disarm = () => { cancelTimer?.(); cancelTimer = undefined; };
  const queue = () => { if (!closed) { cancelTimer?.(); cancelTimer = clock.at(clock.now(), pump); } };
  const output = z.unknown();
  function register<I>(name: string, input: z.ZodType<I>, write: boolean, may: (v: Viewer, i: I) => boolean, run: (ctx: Context, i: I) => unknown, internal = false) {
    operations.register(operation({ name: `clock.${name}`, input, output, write, cli: clockCommands.find(c => c.name === clockOperationCommands[name]), ...(internal ? { doors: ['direct' as const] } : {}), may,
      run(ctx, i) { if (closed) throw new OperationError('unavailable', 'Clock stopped'); const result = run(ctx, i); if (write) queue(); return result; } }));
  }
  function make(ctx: Context, w: Work, due: number, extra: Partial<Wake> = {}) {
    const row: Wake = { ...work(w), id: `w-${randomUUID()}`, due, state: 'pending', createdAt: ctx.now, changedAt: ctx.now, by: ctx.viewer, failures: 0, ...extra };
    saveWake(ctx, row); event(ctx, row, 'set'); return row;
  }
  function next(ctx: Context, s: Schedule, after: number) {
    if (!s.enabled || wakes(db).some(w => w.schedule === s.id && active(w) && w.due > after)) return;
    make({ ...ctx, viewer: s.by }, s, calendar(() => nextOccurrence(s, after)), { schedule: s.id });
  }
  function oneOffRoom(agent: string) {
    // Before runNow was recorded, immediate lane runs carried only bypassPause.
    const oneOff = (w: Wake) => !w.schedule || w.runNow || (w.runNow === undefined && w.laneVersion && w.bypassPause);
    if (wakes(db).filter(w => w.agent === agent && oneOff(w) && active(w)).length >= 50) invalid('At most 50 pending one-off wakes');
  }
  const timed = workInput.extend({ when: text });
  for (const name of ['at', 'in'] as const) register(name, timed, true, create, (ctx, i) => {
    work(i);
    const due = calendar(() => name === 'at' ? parseAt(i.when, ctx.now) : parseIn(i.when, ctx.now));
    if (due <= ctx.now) invalid('Wake must be in the future');
    // Only a currently owner-authored schedule can stand in for a self-chain.
    // Agent-authored schedules need runtime conversation provenance first.
    if (i.file && !i.continuation && !i.approval && !i.place && !paused(db, i.agent)) {
      for (const s of schedules(db)) {
        if (!s.enabled || s.continuation || s.approval || s.place || s.agent !== i.agent || s.project !== i.project || s.member !== i.member
          || (s.laneDetails?.source ?? s.file) !== i.file || !see(ctx.viewer, s, 'schedule')
          || s.by.kind !== 'member' || !mayAct(s.by, {}, sharing(), 'household') || !create(s.by, s)
          || !(ctx.viewer.kind === 'agent' && ctx.viewer.id === i.agent || ctx.viewer.kind === 'member' && ctx.viewer.id === s.by.id)) continue;
        const occurrence = wakes(db).filter(w => w.schedule === s.id && w.state === 'pending' && !w.runNow && !w.bypassPause
          && !w.continuation && !w.approval && !w.place
          && w.due > ctx.now && w.laneVersion === s.laneVersion && w.scheduleRevision === s.scheduleRevision)
          .sort((a, b) => a.due - b.due)[0];
        if (occurrence && Math.abs(due - occurrence.due) <= 6 * 3600_000)
          return { alreadyScheduled: true, schedule: s.id, due: occurrence.due };
      }
    }
    oneOffRoom(i.agent);
    return make(ctx, i, due);
  });
  register('park', workInput.extend({ on: text }), true, (v, i) => create(v, i) && !!options.approvals?.check(i.on, v), (ctx, i) => {
    if (!/^[aq]-[\w-]+$/.test(i.on)) invalid('Park on an approval or question');
    oneOffRoom(i.agent);
    const a = options.approvals!.check(i.on, ctx.viewer)!;
    return make(ctx, i, ctx.now, { state: 'parked', wait: { id: i.on, until: ctx.now + day, kind: a.kind, target: a.target } });
  });
  register('list', z.object({ agent: text.optional() }), false, () => true, (ctx, i) => wakes(db).filter(w => see(ctx.viewer, w) && (!i.agent || w.agent === i.agent) && (active(w) || w.changedAt + day > ctx.now)));
  register('log', z.object({ since: z.number().optional(), grep: z.string().optional() }), false, () => true, (ctx, i) => {
    const ids = new Set(wakes(db).filter(w => see(ctx.viewer, w)).map(w => w.id));
    return (db.prepare('SELECT wake,record FROM clock_events ORDER BY seq').all() as { wake: string; record: string }[]).filter(r => ids.has(r.wake)).map(r => JSON.parse(r.record)).filter(r => (i.since === undefined || r.at >= i.since) && (!i.grep || JSON.stringify(r).includes(i.grep)));
  });
  register('cancel', idInput, true, (v, i) => !wake(db, i.id) || act(v, get(i.id)), (ctx, i) => {
    const w = get(i.id); if (!active(w) || w.hold === 'uncertain') return w;
    const firing = w.state === 'firing'; w.state = firing ? 'held' : 'cancelled'; if (firing) w.hold = 'uncertain'; w.outcome = firing ? 'Cancellation raced dispatch; a body may have started' : 'Cancelled';
    saveWake(ctx, w); event(ctx, w, 'cancel');
    const s = w.schedule && schedule(db, w.schedule); if (s) next(ctx, s, Math.max(w.due, ctx.now)); return w;
  });
  const nowInput = z.union([idInput.strict(), z.object({ agent: text, note: z.string().max(100_000).optional() }).strict()]);
  register('now', nowInput, true, (v, i) => 'id' in i
    ? !!wake(db, i.id) && act(v, get(i.id), true) && create(v, get(i.id))
    : act(v, { agent: i.agent, note: '' }, true) && create(v, { agent: i.agent, note: '' }), (ctx, i) => {
    if (!('id' in i)) return make(ctx, { agent: i.agent, note: i.note || 'woken now from loom',
      prompt: `Woken now: ${ctx.viewer.id} asked for a wake from loom's Clock page, with no lane. Look at what deserves attention: your work queue, recent loom memory, Your call, the state of the machine. Do something useful or file what you find.` }, ctx.now, { bypassPause: true });
    const w = get(i.id); if (w.state === 'firing' || w.state === 'fired' || w.state === 'cancelled') invalid('Wake already dispatched or cancelled');
    if (w.hold === 'uncertain') invalid('Uncertain dispatch needs reconciliation before another body can start');
    w.state = 'pending'; w.due = ctx.now; w.bypassPause = true; w.runNow ??= false; delete w.hold; saveWake(ctx, w); return w;
  });
  const agentInput = z.object({ agent: text });
  register('pause', agentInput, true, (v, i) => act(v, { agent: i.agent, note: '' }, true), (ctx, i) => {
    db.prepare('INSERT OR IGNORE INTO clock_pauses VALUES (?,?)').run(i.agent, ctx.now); ctx.changed('clock', i.agent); return { agent: i.agent, paused: true };
  });
  register('resume', agentInput, true, (v, i) => act(v, { agent: i.agent, note: '' }, true), (ctx, i) => {
    db.prepare('DELETE FROM clock_pauses WHERE agent=?').run(i.agent);
    let n = 0; for (const w of wakes(db).filter(w => w.agent === i.agent && w.state === 'held' && w.hold === 'paused').sort((a,b) => a.due-b.due || a.id.localeCompare(b.id))) {
      w.state = 'pending'; w.due = ctx.now + ++n * 60_000; delete w.hold; saveWake(ctx, w);
    }
    ctx.changed('clock', i.agent); return { agent: i.agent, paused: false, released: n };
  });
  register('status', agentInput, false, (v, i) => see(v, { agent: i.agent, note: '' }), (_ctx, i) => ({ id: i.agent, paused: paused(db, i.agent) }));
  const deskWakes = (v: Viewer, agent: string) => wakes(db).filter(w => w.agent === agent && active(w) && see(v, w));
  register('jobs', agentInput, false, (v, i) => see(v, { agent: i.agent, note: '' }), (ctx, i) => deskJobs(deskWakes(ctx.viewer, i.agent), paused(db, i.agent)));
  register('agentNext', agentInput, false, (v, i) => see(v, { agent: i.agent, note: '' }), (ctx, i) => agentNext(i.agent, deskWakes(ctx.viewer, i.agent), paused(db, i.agent)));

  const scheduleInput = workInput.extend({ id: text, at: z.union([text, z.array(text)]), days: z.string().default(''), lane: text.optional() });
  register('scheduleSet', scheduleInput, true, (v, i) => create(v, i) && (!schedule(db, i.id) || act(v, schedule(db, i.id)!, !!schedule(db, i.id)!.laneDetails)), (ctx, i) => {
    work(i); calendar(() => daysOf(i.days));
    const old = schedule(db, i.id);
    if (old?.laneDetails) invalid('Edit household lanes with laneSet');
    if (old && (old.agent !== i.agent || old.project !== i.project || old.member !== i.member)) invalid('Remove a schedule before changing its scope');
    const s: Schedule = { ...i, at: calendar(() => timesOf(i.at)), scheduleRevision: randomUUID(), by: ctx.viewer, enabled: true, changedAt: ctx.now };
    cancelOccurrences(ctx, s.id, 'Schedule changed');
    saveSchedule(ctx, s); next(ctx, s, ctx.now); return s;
  });
  register('schedules', z.object({}), false, () => true, ctx => schedules(db).filter(s => see(ctx.viewer, s, 'schedule')));
  register('scheduleRemove', idInput, true, (v, i) => { const s = schedule(db, i.id); return !s || act(v, s, !!s.laneDetails) && (!s.laneDetails || create(v, s)); }, (ctx, i) => {
    const s = schedule(db, i.id); if (!s) throw new OperationError('not-found', 'Schedule not found');
    removeSchedule(ctx, s); return { id: s.id };
  });
  register('scheduleRun', idInput.extend({ note:z.string().max(100_000).optional() }), true, (v, i) => { const s = schedule(db, i.id); return !!s && act(v, s, true) && create(v, s); }, (ctx, i) => {
    const s = schedule(db, i.id)!;
    oneOffRoom(s.agent);
    return make(ctx, i.note === undefined ? s : { ...s, note: `${s.lane ?? s.id.split('/').pop()} run now${i.note ? `: ${i.note}` : ''}` }, ctx.now, { bypassPause: true, runNow: true, ...(s.laneDetails ? { schedule: s.id } : {}) });
  });
  const laneName = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/);
  const laneId = (name: string) => `lane/${name}`;
  const getLane = (name: string) => { const s = schedule(db, laneId(name)); if (!s?.laneDetails) throw new OperationError('not-found', 'Lane not found'); return s; };
  const laneInput = z.object({ name: laneName });
  const laneSetInput = laneInput.extend({ agent: text.optional(), at: z.union([text, z.array(text)]).optional(), days: z.string().optional(),
    text: text.optional(), source: text.optional(), local: z.boolean().optional(), note: z.string().max(100_000).optional(), model: text.optional(), slot: laneName.optional() });
  const cancelLaneWork = (ctx: Context, w: Wake, reason: string) => { w.state = 'cancelled'; w.outcome = reason; saveWake(ctx, w); event(ctx, w, 'cancel'); };
  const cancelOccurrences = (ctx: Context, id: string, reason = 'Lane changed') => {
    for (const w of wakes(db).filter(w => w.schedule === id && active(w) && w.state !== 'firing' && w.hold !== 'uncertain')) cancelLaneWork(ctx, w, reason);
  };
  const removeSchedule = (ctx: Context, s: Schedule) => {
    cancelOccurrences(ctx, s.id, s.laneDetails ? 'Lane changed' : 'Schedule removed'); db.prepare('DELETE FROM clock_schedules WHERE id=?').run(s.id); ctx.changed('schedule', s.id);
  };
  function setLane(ctx: Context, i: z.infer<typeof laneSetInput>) {
    const old = schedule(db, laneId(i.name));
    if (old && !old.laneDetails) invalid('Schedule id is already in use');
    const details = { text: i.text ?? old?.laneDetails?.text ?? '', local: i.local ?? old?.laneDetails?.local ?? false,
      ...(i.source !== undefined ? { source: i.source } : i.text !== undefined ? {} : old?.laneDetails?.source ? { source: old.laneDetails.source } : {}) };
    const agent = i.agent ?? old?.agent, at = i.at ?? old?.at;
    if (!agent || !at || !details.text) invalid('A new lane needs agent, time and text');
    if (details.source && (/^(?:\/|[A-Za-z]:)/.test(details.source) || details.source.split('/').includes('..'))) invalid('Lane sources must be relative repository paths');
    const days = i.days ?? old?.days ?? ''; calendar(() => daysOf(days));
    const head = `This is a loom lane: household work on a schedule ("${i.name}"), assigned to you; the owner reassigns it on loom's Clock page. Do it as yourself.\n\n`;
    const body = details.text.length <= 6500 ? details.text : `The lane's text is too long to hand over here: read it with \`wake lane text ${i.name}\` and follow it exactly, as if it were this prompt.`;
    const s: Schedule = { id: laneId(i.name), lane: i.name, agent: agent!, at: calendar(() => timesOf(at!)), days,
      prompt: (details.local ? '<!-- house: local -->\n' : '') + head + body, note: i.note ?? old?.note ?? '', model: i.model ?? old?.model, slot: i.slot ?? old?.slot,
      laneDetails: details, laneVersion: randomUUID(), by: ctx.viewer, enabled: true, changedAt: ctx.now };
    cancelOccurrences(ctx, s.id);
    // A file-backed lane replaces a self-chained one-off only on its assignee's clock.
    if (details.source) for (const w of wakes(db).filter(w => w.agent === s.agent && w.by.kind === 'agent' && w.by.id === s.agent && !w.schedule && w.file === details.source && w.state === 'pending')) {
      cancelLaneWork(ctx, w, 'Replaced by household lane');
    }
    saveSchedule(ctx, s); next(ctx, s, ctx.now); return s;
  }
  const maySetLane = (v: Viewer, i: z.infer<typeof laneSetInput>) => {
    const old = schedule(db, laneId(i.name)), agent = i.agent ?? old?.agent;
    return mayAct(v, {}, sharing(), 'household') && !!agent && create(v, { agent, note: '' });
  };
  register('laneSet', laneSetInput, true, maySetLane, setLane);
  register('laneAssign', laneInput.extend({ agent: text }), true, maySetLane, (ctx, i) => { getLane(i.name); return setLane(ctx, i); });
  register('laneRemove', laneInput, true, (v, i) => { const s = schedule(db, laneId(i.name)); return mayAct(v, {}, sharing(), 'household') && (!s || create(v, s)); }, (ctx, i) => {
    const s = getLane(i.name); removeSchedule(ctx, s); return { name: i.name };
  });
  register('lanes', z.object({}), false, () => true, ctx => schedules(db).filter(s => s.laneDetails && see(ctx.viewer, s, 'schedule')));
  register('laneText', laneInput, false, (v, i) => { const s = schedule(db, laneId(i.name)); return !s || see(v, s, 'schedule'); }, (_ctx, i) => ({ text: getLane(i.name).laneDetails!.text }));
  register('rearm', z.object({}), true, (v) => mayAct(v, {}, sharing(), 'household'), () => ({ rearmed: true }));
  operations.register(operation({ name: 'clock.command', write: true,
    input: z.object({ argv: z.array(z.string()).max(100), agent: text.optional(), laneFile: z.object({path:text,text:z.string().max(100_000)}).optional() }),
    output: z.object({ exit:z.number().int(), stdout:z.string(), stderr:z.string() }),
    may: viewer => viewer.kind === 'member' || viewer.kind === 'agent',
    run: (ctx,input) => command(operations,ctx.viewer,input),
  }));
  // Intent and outcome use the registry too: all state and live changes commit together.
  register('dispatch', idInput.extend({ attempt: text }), true, (v, i) => !!wake(db, i.id) && create(v, get(i.id)), (ctx, i) => {
    const w = get(i.id); if (w.state !== 'pending' || w.due > ctx.now) return null;
    if (paused(db, w.agent) && !w.bypassPause) { w.state = 'held'; w.hold = 'paused'; saveWake(ctx, w); return null; }
    w.state = 'firing'; w.attempt = i.attempt; saveWake(ctx, w); event(ctx, w, 'intent');
    const s = w.schedule && schedule(db, w.schedule); if (s && !wakes(db).some(other => other.id !== w.id && other.schedule === s.id && active(other) && other.due > w.due)) {
      // The firing occurrence no longer counts as the future occurrence.
      make({ ...ctx, viewer: s.by }, s, calendar(() => nextOccurrence(s, Math.max(ctx.now, w.due))), { schedule: s.id });
    }
    return w;
  }, true);
  register('outcome', idInput.extend({ attempt: text, result: startResult }), true, (v, i) => !!wake(db, i.id) && act(v, get(i.id)), (ctx, i) => {
    const w = get(i.id); if (w.state !== 'firing' || w.attempt !== i.attempt) return null;
    const r = i.result;
    let eventKind: string | undefined;
    if (r.state === 'started') { w.state = 'fired'; w.outcome = r.body; }
    else if (r.state === 'not-started') {
      w.outcome = r.reason;
      if (w.laneVersion && (!w.schedule || schedule(db, w.schedule)?.laneVersion !== w.laneVersion)) { w.state = 'cancelled'; w.outcome = `Superseded lane did not start: ${r.reason}`; }
      else if (w.scheduleRevision && w.schedule && schedule(db, w.schedule)?.scheduleRevision !== w.scheduleRevision) { w.state = 'cancelled'; w.outcome = `Superseded schedule did not start: ${r.reason}`; }
      else if (r.code === 'quota') {
        if (w.place === 'alert:runtime-quota') { w.state = 'cancelled'; eventKind = 'quota-notice'; }
        else { w.state = 'pending'; w.due = quotaDue(r.retryAfter, ctx.now); eventKind = 'quota-wait'; }
      }
      // A continuation's report authority belongs to this firing; a fresh
      // attempt after a definite failure cannot carry that authority forward.
      else if (++w.failures >= 6 || w.continuation) w.state = 'failed';
      else { w.state = 'pending'; w.due = Math.max(ctx.now + 1, r.retryAt ?? ctx.now + 15 * 60_000 * 2 ** (w.failures-1)); }
    } else { w.state = 'held'; w.hold = r.state === 'uncertain' ? 'uncertain' : 'staging'; w.outcome = r.reason; }
    saveWake(ctx, w); event(ctx, w, eventKind ?? w.state);
    // Source-owned ids survive receipt retries and restarts. Household notices
    // deliberately carry no prompt, note, file, scope or runtime error words.
    const notice = r.state === 'not-started' && w.state !== 'cancelled'
      ? r.code === 'quota' ? 'quota' : w.state === 'failed' ? 'failed' : w.failures === 3 ? 'retry' : undefined
      : eventKind === 'quota-notice' ? 'quota' : undefined;
    if (notice) options.notices?.raise(ctx, {
      id: `clock:${w.id}:${notice}`,
      ask: notice === 'quota' ? 'Review clock work waiting for model capacity.'
        : notice === 'failed' ? 'Review clock work that could not start.' : 'Review clock work after three failed starts.',
      why: notice === 'quota' ? 'The runtime reported no model capacity; the clock recorded its bounded wait or stopped quota triage.'
        : notice === 'failed' ? 'The clock stopped automatic retries. Inspect the wake before deciding what to do next.'
        : 'The clock will retry definite start failures up to six times.',
      href: '/p/clock-preview', refs: [w.id],
    });
    return w;
  }, true);
  register('checkPark', idInput, true, (v, i) => !!wake(db, i.id) && act(v, get(i.id)), (ctx, i) => {
    const w = get(i.id); if (w.state !== 'parked' || !w.wait) return null;
    const a = options.approvals?.check(w.wait.id, w.by);
    if (a && a.state !== 'pending' || ctx.now >= w.wait.until) {
      // Pending at the deadline is unanswered, not an expired Allow. If the role
      // cannot read the request, never reuse its saved kind/target as authority.
      unpark(w, a ?? { state: 'unknown' });
      w.state = 'pending'; w.due = ctx.now; saveWake(ctx, w); event(ctx, w, 'unpark');
    } else { w.due = Math.min(w.wait.until, ctx.now + 5 * 60_000); saveWake(ctx, w); }
    return w;
  }, true);
  const call = (w: Wake, verb: string, input: object) => operations.call('direct', w.by, `clock.${verb}`, input, randomUUID());
  function pump() {
    if (closed) return;
    disarm();
    const checkAnswers = parksChanged; parksChanged = false;
    for (const w of wakes(db).filter(w => (w.state === 'pending' || w.state === 'parked') && (w.due <= clock.now() || w.state === 'parked' && checkAnswers))) {
      if (w.state === 'parked') { const checked = call(w, 'checkPark', { id: w.id }); if (!checked.ok) holdDenied(w); continue; }
      const attempt = randomUUID(), intent = call(w, 'dispatch', { id: w.id, attempt });
      if (!intent.ok) { holdDenied(w); continue; }
      if (!intent.value) continue;
      // Invocation happens after the registry has committed the intent, never within its transaction.
      void Promise.resolve().then(() => closed || wake(db, w.id)?.state !== 'firing' ? undefined : runtime.startBody({ wake: intent.value as Wake, viewer: w.by, intent: attempt })).catch((): StartResult => ({ state: 'uncertain', reason: 'Runtime did not confirm whether a body started' })).then(result => {
        if (!closed && result) { const parsed = startResult.safeParse(result); result = parsed.success ? parsed.data : { state: 'uncertain', reason: 'Runtime returned an invalid outcome' }; const answer = call(w, 'outcome', { id: w.id, attempt, result }); if (!answer.ok) { const current = wake(db, w.id); if (current?.state === 'firing') holdDenied(current, true); } }
      });
    }
    const due = wakes(db).filter(w => w.state === 'pending' || w.state === 'parked').map(w => w.due);
    if (due.length) { disarm(); cancelTimer = clock.at(Math.min(...due), pump); }
  }
  function holdDenied(w: Wake, uncertain = false) {
    // Maintaining an existing row after access revocation grants no external authority.
    db.transaction(() => { w.state = 'held'; w.hold = uncertain ? 'uncertain' : 'permission'; w.outcome = uncertain ? 'Dispatch outcome could not be recorded; reconcile with runtime' : 'Dispatch authority is no longer available'; w.changedAt = clock.now(); db.prepare('UPDATE clock_wakes SET record=?,changed_at=? WHERE id=?').run(JSON.stringify(w), w.changedAt, w.id); })();
    live.changed([{ type: 'wake', id: w.id }]);
  }
  // A crash leaves no reliable way to decide whether runtime received the intent.
  db.transaction(() => {
    for (const w of wakes(db).filter(w => w.state === 'firing')) { w.state = 'held'; w.hold = 'uncertain'; w.outcome = 'Restart interrupted dispatch; reconcile with runtime before retrying'; w.changedAt = clock.now(); db.prepare('UPDATE clock_wakes SET record=?,changed_at=? WHERE id=?').run(JSON.stringify(w), w.changedAt, w.id); }
  })();
  for (const type of ['wake', 'schedule'] as const) live.register({ name: type,
    ids: () => (type === 'wake' ? wakes(db) : schedules(db)).map(w => w.id),
    read(id, v) { const w = type === 'wake' ? wake(db, id) : schedule(db, id); return w && see(v, w, type) ? { ...w } : undefined; },
    inScope: (r, agent, now) => (!agent || r.agent === agent) && (type === 'schedule' || active(r as unknown as Wake) || Number(r.changedAt) + day > now),
    expires: r => type === 'wake' && !active(r as unknown as Wake) ? Number(r.changedAt) + day : undefined,
  });
  live.register({ name: 'clock', ids: () => [...new Set([...wakes(db).map(w => w.agent), ...schedules(db).map(s => s.agent), ...(db.prepare('SELECT agent FROM clock_pauses').all() as { agent: string }[]).map(p => p.agent)])], read: (id, v) => see(v, { agent: id, note: '' }) ? { id, paused: paused(db, id) } : undefined, inScope: () => true });
  const unsubscribe = options.approvals?.subscribe(() => { parksChanged = true; queue(); });
  queue();
  return { close() { if (closed) return; closed = true; cancelTimer?.(); unsubscribe?.(); } };
}
