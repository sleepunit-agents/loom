import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { CheckIcon, ChevronLeftIcon, ChevronRightIcon, PlusIcon } from 'lucide-react';
import {
  ContextDirectory,
  contextTitlePrefix,
  type ContextRow,
  type DirectoryStatus,
} from '../data/context-directory';
import { useDataQuery } from '../data/graphql';
import { newId } from '../data/id';
import { memberOperation } from '../data/operation';
import { Button } from './ui/button';
import { QuickBar } from './quick-bar';

export type Place = {
  id: string;
  thread: string;
  name: string;
  agent: string | null;
  detail: string;
  row?: ContextRow;
};
type Page = { rows: ContextRow[]; status: DirectoryStatus };
function currentContext() {
  return new URL(location.href).searchParams.get('ctx') || 'loom';
}

function hue(id: string) {
  if (id === 'loom') return 169;
  if (id === 'home') return 265;
  let hash = 0;
  for (const char of id) hash = (Math.imul(hash, 31) + char.charCodeAt(0)) | 0;
  return (hash >>> 0) % 360;
}

function ContextSignal({ place, report }: { place: Place; report: (id: string, reason: string) => void }) {
  const row = place.row;
  const feed = useDataQuery<{
    needs: { id: string; answers: string | null }[];
    latest: { seq: number; kind: string }[];
  }>(
    'query PairContextSignal($conversation:String!,$thread:String!){needs:inboxItems(conversation:$conversation,state:"waiting",folder:"needs",limit:1){id answers} latest:commsMessages(thread:$thread,limit:1){seq kind}}',
    { conversation: row?.conversation || '', thread: place.thread },
    { pause: !row },
  );
  const last = feed.data?.latest[0];
  const reason =
    feed.status !== 'live' || !row
      ? ''
      : feed.data?.needs.length
        ? feed.data.needs[0].answers
          ? 'Has a question for you'
          : 'Needs your attention'
        : last && last.seq > row.readSeq && last.kind === 'reply'
          ? 'New reply'
          : '';
  useEffect(() => {
    report(place.id, reason);
  }, [place.id, reason, report]);
  return null;
}

export function ContextSwitcher({
  member,
  ticket,
  home,
  children,
}: {
  member: string;
  ticket: Place;
  home: Place;
  children: (place: Place, naming: boolean) => ReactNode;
}) {
  const [pages, setPages] = useState<Record<number, Page>>({});
  const onPage = useCallback((offset: number, rows: ContextRow[], status: DirectoryStatus) => {
    setPages((old) => {
      const next = { ...old, [offset]: { rows, status } };
      if (rows.length < 50) for (const key of Object.keys(next)) if (+key > offset) delete next[+key];
      return next;
    });
  }, []);
  const pageList = Object.values(pages);
  const loaded =
    pageList.length > 0 && pageList.every((p) => p.status === 'live') && pageList.at(-1)!.rows.length < 50;
  const offline = pageList.some((p) => p.status === 'offline' || p.status === 'denied');
  const rows = new Map(
    pageList
      .flatMap((p) => p.rows)
      .filter((r) => r.member === member)
      .map((r) => [r.id, r]),
  );
  const places: Place[] = [home, ticket].map((p) => ({ ...p, row: rows.get(p.thread) }));
  for (const row of [...rows.values()]
    .filter((r) => r.id.startsWith('th:ctx-'))
    .sort((a, b) => a.id.localeCompare(b.id))) {
    places.push({
      id: row.id,
      thread: row.id,
      name: row.title.startsWith(contextTitlePrefix) ? row.title.slice(contextTitlePrefix.length) : row.title,
      agent: row.agent,
      detail: 'With ' + (row.agent === 'art' ? 'Art' : row.agent),
      row,
    });
  }
  const [selected, select] = useState(currentContext);
  const place = places.find((p) => p.id === selected);
  // Snapshot only the canvas. The switcher, portrait, and conversation stay interactive.
  const pendingTransition = useRef<ViewTransition | null>(null);
  const switchTo = useCallback((id: string) => {
    pendingTransition.current?.skipTransition();
    if (!document.startViewTransition || document.hidden || matchMedia('(prefers-reduced-motion: reduce)').matches) {
      pendingTransition.current = null;
      select(id);
      return;
    }
    const transition = document.startViewTransition(() => {
      if (pendingTransition.current === transition) flushSync(() => select(id));
    });
    pendingTransition.current = transition;
    void transition.finished.finally(() => {
      if (pendingTransition.current === transition) pendingTransition.current = null;
    });
  }, []);
  const [revealed, reveal] = useState(false),
    [adding, add] = useState(false);
  // Rows are 3.25rem tall with a .25rem gap. Leave room for the strip and controls.
  const availableRows = () =>
    Math.max(
      1,
      Math.floor(
        ((window.visualViewport?.height ?? window.innerHeight) /
          parseFloat(getComputedStyle(document.documentElement).fontSize) -
          10) /
          3.5,
      ),
    );
  const [pageSize, setPageSize] = useState(availableRows);
  const [requestedPage, setRequestedPage] = useState<number | null>(null);
  const pageCount = Math.ceil(places.length / pageSize);
  const selectedIndex = Math.max(
    0,
    places.findIndex((p) => p.id === selected),
  );
  const page = Math.min(requestedPage ?? Math.floor(selectedIndex / pageSize), pageCount - 1);
  const first = page * pageSize;
  const visiblePlaces = places.slice(first, first + pageSize);
  useEffect(() => {
    if (!revealed) return;
    const resize = () => setPageSize(availableRows());
    resize();
    window.addEventListener('resize', resize);
    window.visualViewport?.addEventListener('resize', resize);
    return () => {
      window.removeEventListener('resize', resize);
      window.visualViewport?.removeEventListener('resize', resize);
    };
  }, [revealed]);
  const [name, setName] = useState(''),
    [error, fail] = useState(''),
    [busy, saving] = useState(false);
  const [signals, setSignals] = useState<Record<string, string>>({});
  const report = useCallback(
    (id: string, reason: string) =>
      setSignals((s) => ((s[id] || '') === reason ? s : { ...s, [id]: reason })),
    [],
  );
  const nav = useRef<HTMLElement>(null),
    trigger = useRef<HTMLButtonElement>(null);
  const pending = useRef<{ name: string; id: string } | null>(null),
    locked = useRef(false);
  const restoring = useRef(false);
  function close(restore = false) {
    restoring.current = true;
    if (restore) trigger.current?.focus({ preventScroll: true });
    setRequestedPage(null);
    reveal(false);
    restoring.current = false;
  }
  useEffect(() => {
    function back() {
      switchTo(currentContext());
      close();
      add(false);
    }
    window.addEventListener('popstate', back);
    return () => window.removeEventListener('popstate', back);
  }, [switchTo]);
  useEffect(() => {
    if (!revealed) return;
    const outside = (e: PointerEvent) => {
      if (!nav.current?.contains(e.target as Node)) close();
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [revealed]);
  function choose(id: string) {
    if (id !== currentContext()) {
      const url = new URL(location.href);
      if (id === 'loom') url.searchParams.delete('ctx');
      else url.searchParams.set('ctx', id);
      history.pushState(null, '', url);
      switchTo(id);
    }
    close(true);
    add(false);
  }
  async function create() {
    const title = name.trim();
    if (!title || !ticket.agent || !loaded || locked.current) return;
    if (places.some((p) => p.id !== pending.current?.id && p.name.toLowerCase() === title.toLowerCase())) {
      fail('A context already has that name.');
      return;
    }
    if (pending.current?.name !== title) pending.current = { name: title, id: 'th:ctx-' + newId() };
    locked.current = true;
    saving(true);
    fail('');
    try {
      const thread = pending.current.id;
      await memberOperation(
        'comms.open',
        { agent: ticket.agent, thread, title: contextTitlePrefix + title },
        thread.slice(7),
      );
      pending.current = null;
      setName('');
      add(false);
      if (document.activeElement?.closest('#context-name-prompt')) close(true);
    } catch {
      fail('Creation unconfirmed. Retry with the same name.');
    } finally {
      locked.current = false;
      saving(false);
    }
  }
  return (
    <>
      <ContextDirectory member={member} offset={0} onPage={onPage} />
      {places.map((p) => (
        <ContextSignal key={p.id} place={p} report={report} />
      ))}
      <nav
        ref={nav}
        aria-label="Contexts"
        className="pair-contexts"
        onPointerEnter={(e) => {
          if (e.pointerType === 'mouse' && !adding) reveal(true);
        }}
        onPointerLeave={(e) => {
          if (e.pointerType === 'mouse' && !adding && !nav.current?.querySelector(':focus-visible')) close();
        }}
        onBlur={(e) => {
          if (e.relatedTarget && !e.currentTarget.contains(e.relatedTarget)) close();
        }}
        onKeyDown={(e) => {
          const choices = Array.from(
            e.currentTarget.querySelectorAll<HTMLButtonElement>('[data-context-choice]'),
          );
          const index = choices.indexOf(e.target as HTMLButtonElement);
          if (index >= 0 && ['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft'].includes(e.key)) {
            e.preventDefault();
            const step = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : -1;
            const next = (first + index + step + places.length) % places.length;
            setRequestedPage(Math.floor(next / pageSize));
            requestAnimationFrame(() =>
              nav.current
                ?.querySelectorAll<HTMLButtonElement>('[data-context-choice]')
                [next % pageSize]?.focus(),
            );
          }
          if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            close(true);
          }
        }}
      >
        <button
          ref={trigger}
          type="button"
          className="context-traces"
          aria-label={'Switch context · ' + (place?.name || 'Unavailable')}
          aria-expanded={revealed}
          aria-controls="context-choices"
          onFocus={(e) => {
            if (!restoring.current && e.currentTarget.matches(':focus-visible')) reveal(true);
          }}
          onClick={() => reveal(true)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              reveal(true);
              requestAnimationFrame(() =>
                (
                  nav.current?.querySelector<HTMLButtonElement>('[aria-current="page"]') ||
                  nav.current?.querySelector<HTMLButtonElement>('[data-context-choice]')
                )?.focus(),
              );
            }
          }}
        >
          {places.map((p) => (
            <span
              key={p.id}
              aria-hidden="true"
              className="context-trace"
              data-active={selected === p.id}
              data-attention={!!signals[p.id]}
              style={{ backgroundColor: `oklch(0.66 0.105 ${hue(p.id)})` }}
            />
          ))}
        </button>
        <div id="context-choices" className="context-choices" inert={!revealed} aria-hidden={!revealed}>
          <div key={page} className="context-page grid grid-cols-[minmax(0,1fr)] gap-1">
            {visiblePlaces.map((p) => (
              <Button
                key={p.id}
                data-context-choice
                variant="ghost"
                aria-current={selected === p.id ? 'page' : undefined}
                className="h-[3.25rem] min-w-0 w-full justify-start gap-3 px-2 py-2 text-left"
                onClick={() => choose(p.id)}
              >
                <span
                  aria-hidden="true"
                  className="h-6 w-1 shrink-0 rounded-full"
                  style={{ backgroundColor: `oklch(0.66 0.105 ${hue(p.id)})` }}
                />
                <span className="min-w-0 flex-1">
                  <span className="block overflow-clip text-ellipsis whitespace-nowrap">{p.name}</span>
                  <span className="block overflow-clip text-ellipsis whitespace-nowrap text-xs font-normal text-muted-foreground">
                    {signals[p.id] || (p.row?.working ? 'Working' : p.detail)}
                  </span>
                </span>
                {selected === p.id && <CheckIcon aria-hidden="true" />}
              </Button>
            ))}
          </div>
          {pageCount > 1 && (
            <div className="flex items-center justify-end gap-1">
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label="Previous contexts"
                onClick={() => setRequestedPage((page + pageCount - 1) % pageCount)}
              >
                <ChevronLeftIcon />
              </Button>
              <span aria-live="polite" className="text-xs tabular-nums text-muted-foreground">
                {page + 1} / {pageCount}
              </span>
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label="Next contexts"
                onClick={() => setRequestedPage((page + 1) % pageCount)}
              >
                <ChevronRightIcon />
              </Button>
            </div>
          )}
          {offline && (
            <p role="status" className="p-2 text-xs">
              Context directory unavailable.
            </p>
          )}
          <Button
            size="sm"
            variant="ghost"
            className="mt-1 text-muted-foreground"
            disabled={!ticket.agent || !loaded}
            onClick={() => {
              close();
              add(true);
              fail('');
            }}
          >
            <PlusIcon />
            New context
          </Button>
        </div>
      </nav>
      <QuickBar id="context-name-prompt" open={adding} label="New context"
        question="What would you like to call this context?" placeholder="Context name" action="Create"
        value={name} maxLength={48} busy={busy} disabled={!loaded || !ticket.agent} error={error}
        onChange={value => { setName(value); fail(''); }}
        onClose={restore => { add(false); if (restore) close(true); }}
        onSubmit={e => { e.preventDefault(); void create(); }} />
      {place ? (
        children(place, adding)
      ) : (
        <main className="p-10 text-sm" role="status">
          {loaded || offline ? (
            <>
              Context unavailable.{' '}
              <Button variant="link" onClick={() => choose('loom')}>
                Return to ticket
              </Button>
            </>
          ) : (
            'Opening context…'
          )}
        </main>
      )}
    </>
  );
}
