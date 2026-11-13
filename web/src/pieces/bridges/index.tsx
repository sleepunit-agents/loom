import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useRecords, call, type Call } from '../../data';
import { Split, List, Row, Empty, Error, Loading, Button } from '../../kit';
import { bridgeEffects, sendStatus, type VenueRecord, type RouteRecord, type SendRecord, type EffectRecord } from './model';

import { RouteEditor, type RouteWrite } from './route-editor';
import { VenueEditor } from './venue-editor';
import { routeInput, venueInput, type RouteInput, type VenueInput } from './model';

const idle = { pending: false, status: 'done' as const };
const noop = () => () => {};
function Release({ effect, enabled }: { effect: EffectRecord; enabled: boolean }) {
  const [request, setRequest] = useState<Call<EffectRecord>>();
  const answer = useSyncExternalStore(request?.subscribe ?? noop, request?.getSnapshot ?? (() => idle));
  return <section className="grid gap-3">
    <p>Release permits one attempt to send this reply. A partial or interrupted attempt requires review before any further action.</p>
    {effect.state === 'due' && <Button disabled={!enabled || answer.pending || answer.result?.ok === true} onClick={() => {
      if (enabled && !answer.pending && !answer.result?.ok) setRequest(call<EffectRecord>('core.releaseEffect', { id: effect.id }));
    }}>Release this send</Button>}
    {answer.pending && <Loading label="Releasing send…" />}
    {answer.result?.ok === false && <Error title="Couldn’t release send" text={`${answer.result.code}: ${answer.result.message}`} />}
    {answer.result?.ok && <p role="status">Release accepted</p>}
  </section>;
}

export default function BridgesApp({ path: shellPath, go }: { path?: string; go?: (path: string) => void } = {}) {
  const [localPath, setLocalPath] = useState(() => typeof location === 'undefined' ? '/p/bridges-preview' : location.pathname);
  const path = (shellPath ?? localPath).split('?')[0];
  const match = /\/item\/([^/]+)\/([^/]+)$/.exec(path);
  let selected: { folder: string; id: string } | undefined;
  try { if (match) selected = { folder: match[1], id: decodeURIComponent(match[2]) }; } catch { /* Unknown address stays empty. */ }
  const writes = useRef(new Map<string, RouteWrite>());
  const [requests, setRequests] = useState(new Map<string, RouteWrite>());
  const [latestWrite, setLatestWrite] = useState<RouteWrite>();
  const [folder, setFolder] = useState(selected?.folder ?? 'venues');
  const navigate = (nextFolder: string, id?: string) => {
    const next = '/p/bridges-preview' + (id ? `/item/${nextFolder}/${encodeURIComponent(id)}` : '');
    if (go) go(next); else { if (typeof history !== 'undefined') history.pushState(null, '', next); setLocalPath(next); }
  };
  useEffect(() => {
    if (go || typeof window === 'undefined') return;
    const pop = () => setLocalPath(location.pathname);
    window.addEventListener('popstate', pop); return () => window.removeEventListener('popstate', pop);
  }, [go]);
  const venues = useRecords<VenueRecord>('bridges.venue');
  const routes = useRecords<RouteRecord>('bridges.route');
  const sends = useRecords<SendRecord>('bridges.send');
  const effects = useRecords<EffectRecord>('core.effect');
  // Never retain a detail or actionable effect from a lost subscription.
  const ready = [venues, routes, sends, effects].every(s => s.status === 'live');
  const status = [venues, routes, sends, effects].find(s => s.status !== 'live')?.status;
  const held = ready ? bridgeEffects(effects.records) : [];
  const view = selected?.folder === 'new-route' ? 'routes' : selected?.folder === 'new-venue' ? 'venues' : selected?.folder ?? folder;
  const venue = ready && selected?.folder === 'venues' ? venues.records.find(v => v.id === selected.id) : undefined;
  const route = ready && selected?.folder === 'routes' ? routes.records.find(r => r.id === selected.id) : undefined;
  const send = ready && selected?.folder === 'sends' ? sends.records.find(s => s.id === selected.id)
    : ready && selected?.folder === 'effects' && held.some(e => e.id === selected.id) ? sends.records.find(s => `bridges:${s.id}` === selected.id) : undefined;
  const effect = ready && selected?.folder === 'effects' ? held.find(e => e.id === selected.id)
    : send ? held.find(e => e.id === `bridges:${send.id}`) : undefined;
  const newRoute: RouteInput | undefined = selected?.folder === 'new-route' ? (routes.records.some(r => r.id === selected.id) ? routeInput(routes.records.find(r => r.id === selected.id)!) : { id: selected.id, platform: 'discord', workspace: '', channel: '', peer: false, guest: false, readers: [], notes: [] }) : undefined;
  const newVenue: VenueInput | undefined = selected?.folder === 'new-venue' ? (venues.records.some(v => v.id === selected.id) ? venueInput(venues.records.find(v => v.id === selected.id)!) : { id: selected.id, platform: 'discord', agent: '', workspace: '', bot: '', tokenSecret: '', enabled: true, only: [], ignore: [], botRoles: [] }) : undefined;
  const writeVenue = (kind: RouteWrite['kind'], input: VenueInput | { id: string }) => writeSetup('Venues', kind, input);
  const writeRoute = (kind: RouteWrite['kind'], input: RouteInput | { id: string }) => writeSetup('Routes', kind, input);
  const writeSetup = (table: 'Venues' | 'Routes', kind: RouteWrite['kind'], input: RouteInput | VenueInput | { id: string }) => {
    if (!ready || [...writes.current.values()].some(w => w.call.getSnapshot().pending)) return;
    const request = call<{ id: string }>(`bridges.${kind === 'save' ? 'put' : 'remove'}${table}`, input);
    writes.current.set(`${table}:${input.id}`, { kind, call: request }); setRequests(new Map(writes.current)); setLatestWrite({ kind, call: request });
  };
  const open = (id: string) => navigate(view, id);
  const rows = !ready ? [] : view === 'venues' ? venues.records.map(v => ({ id: v.id, title: `${v.agent} · ${v.platform}`, meta: `${v.workspace} · ${v.received} received · ${v.delivered ?? 0} delivered · ${v.held ?? 0} held in 24 hours`, status: v.enabled ? v.connection : 'Disabled' }))
    : view === 'routes' ? routes.records.map(r => ({ id: r.id, title: r.channel, meta: `${r.platform} · ${r.workspace}`, status: r.primary ? `Primary: ${r.primary}` : 'No primary' }))
    : view === 'sends' ? sends.records.map(s => ({ id: s.id, title: s.id, meta: s.venue, status: sendStatus(s, held.find(e => e.id === `bridges:${s.id}`)) }))
    : held.map(e => ({ id: e.id, title: e.title, meta: e.id, status: e.state === 'uncertain' ? 'Uncertain · review required' : e.state }));
  const reader = !ready ? null : newVenue ? <article className="grid min-w-0 gap-4 [overflow-wrap:anywhere] p-5">
    <VenueEditor key={newVenue.id} connection={newVenue} fresh request={requests.get(`Venues:${newVenue.id}`)} busy={latestWrite?.call} write={writeVenue} />
    <Button variant="outline" onClick={() => navigate('venues', newVenue.id)}>Open saved connection</Button>
  </article> : newRoute ? <article className="grid min-w-0 gap-4 [overflow-wrap:anywhere] p-5">
    <RouteEditor key={newRoute.id} route={newRoute} fresh request={requests.get(`Routes:${newRoute.id}`)} busy={latestWrite?.call} write={writeRoute} />
    <Button variant="outline" onClick={() => navigate('routes', newRoute.id)}>Open saved route</Button>
  </article> : venue ? <article className="grid min-w-0 gap-4 [overflow-wrap:anywhere] p-5">
    <h1 className="text-2xl font-semibold">{venue.agent} · {venue.platform}</h1><p>{venue.enabled ? venue.connection : 'Disabled'}</p>
    <p>Workspace: {venue.workspace}</p><p>Bot: {venue.bot}</p>
    <section><h2>Last 24 hours</h2><p>{venue.received} received · {venue.delivered ?? 0} delivered · {venue.held ?? 0} held</p></section>
    <VenueEditor key={venue.id} connection={venueInput(venue)} fresh={false} request={requests.get(`Venues:${venue.id}`)} busy={latestWrite?.call} write={writeVenue} />
  </article> : route ? <article className="grid min-w-0 gap-4 [overflow-wrap:anywhere] p-5">
    <h1 className="text-2xl font-semibold">Route {route.channel}</h1><p>{route.platform} · {route.workspace}</p>
    <p>Primary: {route.primary ?? 'None'}</p>{route.parent && <p>Parent: {route.parent}</p>}
    <p>{route.guest ? 'Guest route' : 'Household route'} · {route.peer ? 'Peers enabled' : 'Peers disabled'}</p>
    <p>Readers: {route.readers.join(', ') || 'None listed'}</p>
    <RouteEditor key={route.id} route={routeInput(route)} fresh={false} request={requests.get(`Routes:${route.id}`)} busy={latestWrite?.call} write={writeRoute} />
  </article> : send || effect ? <article className="grid min-w-0 gap-4 [overflow-wrap:anywhere] p-5">
    <h1 className="text-2xl font-semibold">{send ? 'Reply send' : effect!.title}</h1>
    {send && <><p>{send.id}</p><p>{sendStatus(send, effect)}</p><p>Connection: {send.venue}</p><p>Receipt: {send.incoming}</p></>}
    {(send?.state === 'uncertain' || effect?.state === 'uncertain') ? <p>Delivery may have partially succeeded. Review it on the venue before deciding what to do. This page cannot resend it.</p>
      : effect && send?.state === 'pending' ? <Release key={effect.id} effect={effect} enabled={ready} />
      : <p>This send is waiting for processing or review.</p>}
  </article> : selected ? <Empty title="This item is no longer in view" text="It may have completed or become unavailable." /> : null;
  return <Split className="h-full" label="Bridges" folder={view} onFolder={id => { setFolder(id); navigate(id); }}
    folders={[
      { id: 'venues', label: 'Connections', count: ready ? venues.records.length : undefined },
      { id: 'routes', label: 'Routes', count: ready ? routes.records.length : undefined },
      { id: 'sends', label: 'Pending sends', count: ready ? sends.records.length : undefined },
      { id: 'effects', label: 'Staged effects', count: ready ? held.length : undefined },
    ]}
    listTitle={view === 'venues' ? 'Connections' : view === 'routes' ? 'Routes' : view === 'sends' ? 'Pending sends' : 'Staged effects'} listMeta={rows.length}
    listTop={ready && view === 'routes' ? <div className="p-3"><Button onClick={() => navigate('new-route', crypto.randomUUID())}>New route</Button></div> : ready && view === 'venues' ? <div className="p-3"><Button onClick={() => navigate('new-venue', crypto.randomUUID())}>New connection</Button></div> : undefined}
    list={!ready ? status === 'loading' ? <Loading label="Opening bridges…" /> : <Error text={status === 'denied' ? 'Sign in with access to bridges.' : 'Waiting for connection.'} />
      : rows.length ? <List label="Bridge items">{rows.map(r => <Row key={r.id} title={r.title} meta={r.meta} status={r.status} selected={r.id === selected?.id} onClick={() => open(r.id)} />)}</List>
      : <Empty title="No items here" text="Configured connections, routes and held sends appear here as they become available." />}
    reader={reader} open={!!selected} onBack={() => { setFolder(view); navigate(view); }} backLabel="Bridges"
    blank={<Empty title="Open a bridge item" text="Choose a connection, route or held send to inspect it." />} />;
}
