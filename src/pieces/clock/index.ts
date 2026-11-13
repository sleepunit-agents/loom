import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { migrate, operation, OperationError, maySee, mayAct, mayCreate, type Db, type Operations, type Live, type Sharing, type Viewer, type Context } from '../../core/index.js';
import { schema } from './schema/001.js';
import { wakes, schedules, wake, schedule, saveWake, saveSchedule, event, paused, active, type Wake, type Work, type Schedule } from './store.js';
import { parseAt, parseIn, nextOccurrence, timesOf, daysOf } from './time.js';
import { stagingRuntime, type Runtime, type StartResult } from './dependencies/runtime.js';
import type { Approvals } from './dependencies/approvals.js';
const day = 86400_000;
const scope = (w: Work, type = 'wake') => ({ type, agent: w.agent, project: w.project, member: w.member });
const text = z.string().min(1).max(100_000);
const workInput = z.object({ agent: text, project: text.optional(), member: text.optional(), prompt: text.optional(), file: text.optional(), note: text,
  model: text.optional(), continuation: text.optional(), slot: text.optional(), approval: text.optional(), place: text.optional() });
const idInput = z.object({ id: text });
const startResult = z.discriminatedUnion('state', [
  z.object({ state: z.literal('started'), body: text }),
  z.object({ state: z.literal('not-started'), reason: text, retryAt: z.number().int().safe().optional() }),
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
export interface ClockOptions { runtime?: Runtime; approvals?: Approvals }
/** Install on the new side only. The composition root must close jobs before its database. */
export function installClock(db: Db, operations: Operations, live: Live, sharing: () => Sharing, options: ClockOptions = {}) {
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
    operations.register(operation({ name: `clock.${name}`, input, output, write, ...(internal ? { doors: ['direct' as const] } : {}), may,
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
  const timed = workInput.extend({ when: text });
  for (const name of ['at', 'in'] as const) register(name, timed, true, create, (ctx, i) => {
    const due = calendar(() => name === 'at' ? parseAt(i.when, ctx.now) : parseIn(i.when, ctx.now));
    if (due <= ctx.now) invalid('Wake must be in the future');
    if (wakes(db).filter(w => w.agent === i.agent && !w.schedule && active(w)).length >= 50) invalid('At most 50 pending one-off wakes');
    return make(ctx, i, due);
  });
  register('park', workInput.extend({ on: text }), true, (v, i) => create(v, i) && !!options.approvals?.check(i.on, v), (ctx, i) => {
    if (!/^[aq]-[\w-]+$/.test(i.on)) invalid('Park on an approval or question');
    const a = options.approvals!.check(i.on, ctx.viewer)!;
    return make(ctx, i, ctx.now, { state: 'parked', wait: { id: i.on, until: ctx.now + day, kind: a.kind, target: a.target } });
  });
  register('list', z.object({ agent: text.optional() }), false, () => true, (ctx, i) => wakes(db).filter(w => see(ctx.viewer, w) && (!i.agent || w.agent === i.agent) && (active(w) || w.changedAt + day > ctx.now)));
  register('log', z.object({ since: z.number().optional(), grep: z.string().optional() }), false, () => true, (ctx, i) => {
    const ids = new Set(wakes(db).filter(w => see(ctx.viewer, w)).map(w => w.id));
    return (db.prepare('SELECT wake,record FROM clock_events ORDER BY seq').all() as { wake: string; record: string }[]).filter(r => ids.has(r.wake)).map(r => JSON.parse(r.record)).filter(r => (i.since === undefined || r.at >= i.since) && (!i.grep || JSON.stringify(r).includes(i.grep)));
  });
  register('cancel', idInput, true, (v, i) => !wake(db, i.id) || act(v, get(i.id)), (ctx, i) => {
    const w = get(i.id); if (!active(w)) return w;
    const firing = w.state === 'firing'; w.state = 'cancelled'; w.outcome = firing ? 'Cancellation raced dispatch; a body may have started' : 'Cancelled';
    saveWake(ctx, w); event(ctx, w, 'cancel');
    const s = w.schedule && schedule(db, w.schedule); if (s) next(ctx, s, Math.max(w.due, ctx.now)); return w;
  });
  register('now', idInput, true, (v, i) => !!wake(db, i.id) && act(v, get(i.id), true), (ctx, i) => {
    const w = get(i.id); if (w.state === 'firing' || w.state === 'fired' || w.state === 'cancelled') invalid('Wake already dispatched or cancelled');
    if (w.hold === 'uncertain') invalid('Uncertain dispatch needs reconciliation before another body can start');
    w.state = 'pending'; w.due = ctx.now; w.bypassPause = true; delete w.hold; saveWake(ctx, w); return w;
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
  const scheduleInput = workInput.extend({ id: text, at: z.union([text, z.array(text)]), days: z.string().default(''), lane: text.optional() });
  register('scheduleSet', scheduleInput, true, (v, i) => create(v, i) && (!schedule(db, i.id) || act(v, schedule(db, i.id)!, !!schedule(db, i.id)!.laneDetails)), (ctx, i) => {
    work(i); calendar(() => daysOf(i.days));
    const old = schedule(db, i.id);
    if (old?.laneDetails) invalid('Edit household lanes with laneSet');
    if (old && (old.agent !== i.agent || old.project !== i.project || old.member !== i.member)) invalid('Remove a schedule before changing its scope');
    const s: Schedule = { ...i, at: calendar(() => timesOf(i.at)), by: old?.by ?? ctx.viewer, enabled: true, changedAt: ctx.now };
    for (const w of wakes(db).filter(w => w.schedule === s.id && active(w) && w.state !== 'firing')) { w.state = 'cancelled'; saveWake(ctx, w); }
    saveSchedule(ctx, s); next(ctx, s, ctx.now); return s;
  });
  register('schedules', z.object({}), false, () => true, ctx => schedules(db).filter(s => see(ctx.viewer, s, 'schedule')));
  register('scheduleRemove', idInput, true, (v, i) => { const s = schedule(db, i.id); return !s || act(v, s, !!s.laneDetails) && (!s.laneDetails || create(v, s)); }, (ctx, i) => {
    const s = schedule(db, i.id); if (!s) throw new OperationError('not-found', 'Schedule not found');
    for (const w of wakes(db).filter(w => w.schedule === s.id && active(w) && w.state !== 'firing')) { w.state = 'cancelled'; saveWake(ctx, w); }
    db.prepare('DELETE FROM clock_schedules WHERE id=?').run(s.id); ctx.changed('schedule', s.id); return { id: s.id };
  });
  register('scheduleRun', idInput, true, (v, i) => { const s = schedule(db, i.id); return !!s && act(v, s, true) && (!s.laneDetails || create(v, s)); }, (ctx, i) => {
    const s = schedule(db, i.id)!;
    return make(ctx, s, ctx.now, { bypassPause: true, ...(s.laneDetails ? { schedule: s.id } : {}) });
  });
  const laneName = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/);
  const laneId = (name: string) => `lane/${name}`;
  const getLane = (name: string) => { const s = schedule(db, laneId(name)); if (!s?.laneDetails) throw new OperationError('not-found', 'Lane not found'); return s; };
  const laneInput = z.object({ name: laneName });
  const laneSetInput = laneInput.extend({ agent: text.optional(), at: z.union([text, z.array(text)]).optional(), days: z.string().optional(),
    text: text.optional(), source: text.optional(), local: z.boolean().optional(), note: z.string().max(100_000).optional(), model: text.optional(), slot: laneName.optional() });
  const cancelLaneWork = (ctx: Context, w: Wake, reason: string) => { w.state = 'cancelled'; w.outcome = reason; saveWake(ctx, w); event(ctx, w, 'cancel'); };
  const cancelOccurrences = (ctx: Context, id: string) => {
    for (const w of wakes(db).filter(w => w.schedule === id && active(w) && w.state !== 'firing')) cancelLaneWork(ctx, w, 'Lane changed');
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
    if (details.source) for (const w of wakes(db).filter(w => w.agent === s.agent && !w.schedule && w.file === details.source && active(w) && w.state !== 'firing')) {
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
    const s = getLane(i.name); cancelOccurrences(ctx, s.id); db.prepare('DELETE FROM clock_schedules WHERE id=?').run(s.id); ctx.changed('schedule', s.id); return { name: i.name };
  });
  register('lanes', z.object({}), false, () => true, ctx => schedules(db).filter(s => s.laneDetails && see(ctx.viewer, s, 'schedule')));
  register('laneText', laneInput, false, (v, i) => { const s = schedule(db, laneId(i.name)); return !s || see(v, s, 'schedule'); }, (_ctx, i) => ({ text: getLane(i.name).laneDetails!.text }));
  register('rearm', z.object({}), true, (v) => mayAct(v, {}, sharing(), 'household'), () => ({ rearmed: true }));
  // Intent and outcome use the registry too: all state and live changes commit together.
  register('dispatch', idInput.extend({ attempt: text }), true, (v, i) => !!wake(db, i.id) && act(v, get(i.id)), (ctx, i) => {
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
    if (r.state === 'started') { w.state = 'fired'; w.outcome = r.body; }
    else if (r.state === 'not-started') {
      w.failures++; w.outcome = r.reason;
      if (w.laneVersion && (!w.schedule || schedule(db, w.schedule)?.laneVersion !== w.laneVersion)) { w.state = 'cancelled'; w.outcome = `Superseded lane did not start: ${r.reason}`; }
      else if (w.failures >= 6) w.state = 'failed';
      else { w.state = 'pending'; w.due = Math.max(ctx.now + 1, r.retryAt ?? ctx.now + 15 * 60_000 * 2 ** (w.failures-1)); }
    } else { w.state = 'held'; w.hold = r.state === 'uncertain' ? 'uncertain' : 'staging'; w.outcome = r.reason; }
    saveWake(ctx, w); event(ctx, w, w.state); return w;
  }, true);
  register('checkPark', idInput, true, (v, i) => !!wake(db, i.id) && act(v, get(i.id)), (ctx, i) => {
    const w = get(i.id); if (w.state !== 'parked' || !w.wait) return null;
    const a = options.approvals?.check(w.wait.id, w.by);
    if (a && a.state !== 'pending' || ctx.now >= w.wait.until) {
      w.wait.answer = !a || a.state === 'pending' ? 'expired' : a.state;
      // Instructions originate in the approvals role, never in request metadata.
      w.prompt = `${w.prompt ?? ''}\n\nOwner answer: ${w.wait.answer}${a?.instruction ? `\n${a.instruction}` : ''}`;
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
  live.register({ name: 'clock', ids: () => [...new Set([...wakes(db), ...schedules(db)].map(w => w.agent))], read: (id, v) => see(v, { agent: id, note: '' }) ? { id, paused: paused(db, id) } : undefined, inScope: () => true });
  const unsubscribe = options.approvals?.subscribe(() => { parksChanged = true; queue(); });
  queue();
  return { close() { if (closed) return; closed = true; cancelTimer?.(); unsubscribe?.(); } };
}
