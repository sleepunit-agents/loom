"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import {
  ActivitySceneContext,
  useActivityPresence,
  useActivityScene,
  type ActivityLayout,
} from "@/lib/cojeev/activity-motion";
import { MARK_PATHS } from "@/lib/cojeev/milestone-travel";
import { useChoreography } from "@/lib/cojeev-motion/choreography";
import { assignMotionRef } from "@/lib/cojeev-motion/refs";
import { useGuidanceMotion } from "@/lib/cojeev-motion/use-guidance-motion";
import { AnimatedIcon } from "@/components/ui/animated-icon";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyTitle } from "@/components/ui/empty";
import { ItemContent, ItemDescription, ItemTitle } from "@/components/ui/item";
import { MotionPresence } from "@/components/ui/presence";
import { BodySecondary, Meta, Title } from "@/components/ui/typography";

export type ActivityEntry = {
  id: string;
  title: React.ReactNode;
  description?: React.ReactNode;
  actor?: { name: string; initials?: string; avatarSrc?: string };
  timestamp?: React.ReactNode;
  /** Machine-readable time matching the caller's timestamp label. */
  dateTime?: string;
  /** Optional visible group heading; shown where a consecutive group begins. */
  group?: string;
  badge?: { label: React.ReactNode; variant?: BadgeProps["variant"] };
  /** Additional supplied details or native actions, kept in document flow. */
  content?: React.ReactNode;
};
export type ActivityFeedProps = Omit<
  React.ComponentProps<"section">,
  "children" | "title"
> & {
  /** Caller supplies the chronological order; the feed never reorders entries. */
  entries: readonly ActivityEntry[];
  title?: React.ReactNode;
  description?: React.ReactNode;
  empty?: React.ReactNode;
  /** Omit to show every supplied entry, including later appends. */
  initialVisible?: number;
  pageSize?: number;
  showMoreLabel?: React.ReactNode;
  /**
   * Look of the history. "thread": one row per entry on a living thread. "ledger": dense,
   * one avatar per run of entries by the same actor within a group, pinned group labels.
   * "bursts": one card per actor's updates made within 30 minutes of each other; two or
   * more become a native disclosure titled "N updates".
   */
  variant?: "thread" | "ledger" | "bursts";
};

/* ---------- grouping: the caller's order is kept; consecutive entries are only gathered ---------- */
const BURST_SPAN = 30 * 60 * 1000;
const actorOf = (entry: ActivityEntry) => entry.actor?.name.trim() ?? "";
const timeOf = (entry: ActivityEntry) => {
  const t = entry.dateTime ? Date.parse(entry.dateTime) : NaN;
  return Number.isFinite(t) ? t : null;
};
function joins(layout: ActivityLayout, newer: ActivityEntry, entry: ActivityEntry) {
  if (layout === "thread" || actorOf(newer) !== actorOf(entry)) return false;
  if (layout === "ledger") return true;
  // A burst needs both times; an entry without one stands alone.
  const a = timeOf(newer),
    b = timeOf(entry);
  return a !== null && b !== null && Math.abs(a - b) <= BURST_SPAN;
}
function runs<T>(items: readonly T[], same: (newer: T, item: T) => boolean) {
  const out: T[][] = [];
  for (const item of items) {
    const last = out[out.length - 1];
    if (last && same(last[last.length - 1], item)) last.push(item);
    else out.push([item]);
  }
  return out;
}
type Keys = ReadonlyMap<string, string>;
/** A day keeps the key of any entry it held before, so prepends and reveals never remount its label. */
function keyGroups(
  groups: readonly (readonly ActivityEntry[])[],
  previous: Keys,
  prefix: string,
) {
  const used = new Set<string>();
  return groups.map((group) => {
    let key = group
      .map((entry) => previous.get(entry.id))
      .find((k): k is string => k !== undefined && !used.has(k));
    if (key === undefined) {
      key = `${prefix}${group[0].id}`;
      while (used.has(key)) key += "+";
    }
    used.add(key);
    return key;
  });
}
const sameKeys = (a: Keys, b: Keys) =>
  a.size === b.size && [...a].every(([id, key]) => b.get(id) === key);
/** Where a row sits in its run or card; only the first row carries the head. */
type Place = {
  first: boolean;
  last: boolean;
  dayEnd: boolean;
  /** Entries in the run or card. */
  size: number;
};

function count(value: number | undefined, fallback: number) {
  return value !== undefined && Number.isFinite(value)
    ? Math.max(1, Math.floor(value))
    : fallback;
}
const initialsOf = (name: string) =>
  name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => Array.from(part)[0])
    .join("");

/** An actor's avatar, or the four-point star for the product's own entries. */
function Mark({ actor }: { actor?: ActivityEntry["actor"] }) {
  if (!actor)
    return (
      <span
        className="v-activity-feed__mark v-activity-feed__marker"
        data-brand=""
      >
        <svg viewBox="-18 -18 36 36" focusable="false" aria-hidden="true">
          <path d={MARK_PATHS.star} />
        </svg>
      </span>
    );
  return (
    <span className="v-activity-feed__mark">
      <Avatar variant="sm">
        {actor.avatarSrc && <AvatarImage src={actor.avatarSrc} alt="" />}
        <AvatarFallback>{actor.initials ?? initialsOf(actor.name)}</AvatarFallback>
      </Avatar>
    </span>
  );
}

function EntryContent({ entry }: { entry: ActivityEntry }) {
  return (
    <ItemContent className="v-activity-feed__content">
      <div className="v-activity-feed__entry-heading">
        <ItemTitle className="v-activity-feed__title">{entry.title}</ItemTitle>
        {entry.badge && (
          <Badge
            size="sm"
            variant={entry.badge.variant ?? "cream"}
            className="v-activity-feed__badge"
          >
            {entry.badge.label}
          </Badge>
        )}
      </div>
      {entry.description && (
        <ItemDescription className="v-activity-feed__description">
          {entry.description}
        </ItemDescription>
      )}
      {(entry.actor || entry.timestamp) && (
        <div className="v-activity-feed__meta">
          {entry.actor && (
            <Meta className="v-activity-feed__who">{entry.actor.name}</Meta>
          )}
          {entry.actor && entry.timestamp && (
            <span aria-hidden="true" className="v-activity-feed__sep">
              ·
            </span>
          )}
          <span aria-hidden="true" className="v-activity-feed__live" />
          {entry.timestamp && (
            <time dateTime={entry.dateTime}>
              <Meta>{entry.timestamp}</Meta>
            </time>
          )}
        </div>
      )}
      {entry.content && (
        <div className="v-activity-feed__details">{entry.content}</div>
      )}
    </ItemContent>
  );
}

/** A day's heading: its own list item, so a row arriving under it never moves it. */
function GroupLabel({ label }: { label: string }) {
  const [ref, leaving] = useActivityPresence<HTMLLIElement>();
  return (
    <li
      ref={ref}
      data-leaving={leaving || undefined}
      inert={leaving || undefined}
      aria-hidden={leaving || undefined}
      className="v-activity-feed__group"
    >
      <div className="v-activity-feed__group-text">{label}</div>
    </li>
  );
}

/*
 * Every row is a direct child of the one list in every look, keyed by its entry: a run or
 * card forming, growing or splitting only changes attributes, never a row's parent.
 */
function Row({
  entry,
  layout,
  place,
}: {
  entry: ActivityEntry;
  layout: ActivityLayout;
  place: Place;
}) {
  const [ref, leaving] = useActivityPresence<HTMLLIElement>();
  const scene = React.useContext(ActivitySceneContext);
  const { first, last, dayEnd, size } = place;
  const name = entry.actor?.name.trim();
  const burst = layout === "bursts" && size > 1;
  const toggle = (event: React.MouseEvent<HTMLElement>) => {
    const details = event.currentTarget.parentElement;
    if (details instanceof HTMLDetailsElement && scene.current?.toggle(details))
      event.preventDefault();
  };
  let body: React.ReactNode;
  if (layout === "thread")
    body = (
      <div className="v-activity-feed__inner">
        <div className="v-activity-feed__portrait" aria-hidden="true">
          <Mark actor={entry.actor} />
        </div>
        <EntryContent entry={entry} />
      </div>
    );
  else if (layout === "ledger")
    body = (
      <div className="v-activity-feed__inner">
        <div className="v-activity-feed__portrait" aria-hidden="true">
          {first && <Mark actor={entry.actor} />}
        </div>
        <div className="v-activity-feed__body-cell">
          {/* Each row keeps the actor in its own accessible text. */}
          {first && name && (
            <p className="v-activity-feed__run-name" aria-hidden="true">
              {name}
            </p>
          )}
          <div className="v-activity-feed__line">
            <span className="v-activity-feed__wash" aria-hidden="true" />
            <EntryContent entry={entry} />
          </div>
        </div>
      </div>
    );
  else
    body = (
      <div className="v-activity-feed__card">
        {first && !burst && (
          <div className="v-activity-feed__card-head" aria-hidden="true">
            <Mark actor={entry.actor} />
            {name && (
              <span className="v-activity-feed__card-who">
                <span className="v-activity-feed__card-name">{name}</span>
              </span>
            )}
          </div>
        )}
        {/* Each row's own disclosure: find in page and links can open a closed burst. */}
        <details
          open
          className="v-activity-feed__fold"
          onToggle={(event) => scene.current?.reveal(event.currentTarget)}
        >
          {first && burst ? (
            <summary className="v-activity-feed__card-head" onClick={toggle}>
              <span aria-hidden="true">
                <Mark actor={entry.actor} />
              </span>
              <span className="v-activity-feed__card-who">
                {name && (
                  <span className="v-activity-feed__card-name">{name}</span>
                )}
                <span className="v-activity-feed__card-count">
                  {size} updates
                </span>
              </span>
              <svg
                className="v-activity-feed__chevron"
                viewBox="0 0 16 16"
                aria-hidden="true"
                focusable="false"
              >
                <path d="M4 6l4 4 4-4" />
              </svg>
            </summary>
          ) : (
            <summary hidden />
          )}
          <div className="v-activity-feed__inner">
            <EntryContent entry={entry} />
          </div>
        </details>
      </div>
    );
  return (
    <li
      ref={ref}
      tabIndex={-1}
      data-activity-entry={entry.id}
      data-leaving={leaving || undefined}
      inert={leaving || undefined}
      aria-hidden={leaving || undefined}
      data-first={(layout !== "thread" && first) || undefined}
      data-last={(layout !== "thread" && last) || undefined}
      data-burst={burst || undefined}
      data-day-end={dayEnd || undefined}
      className="v-activity-feed__entry"
    >
      {body}
    </li>
  );
}

export function ActivityFeed({
  entries,
  title,
  description,
  empty,
  initialVisible,
  pageSize = 3,
  showMoreLabel,
  variant,
  className,
  ref,
  "aria-label": ariaLabel,
  "aria-labelledby": labelledBy,
  ...props
}: ActivityFeedProps) {
  const layout: ActivityLayout =
    variant === "ledger" || variant === "bursts" ? variant : "thread";
  const titleId = React.useId();
  const listId = React.useId();
  const section = React.useRef<HTMLElement | null>(null);
  const setSection = React.useCallback(
    (node: HTMLElement | null) => {
      section.current = node;
      return assignMotionRef(ref, node);
    },
    [ref],
  );
  const layer = React.useRef<SVGSVGElement | null>(null);
  const list = React.useRef<HTMLOListElement>(null);
  const focusIndex = React.useRef<number | null>(null);
  const revealed = React.useRef<string[]>([]);
  const [windowState, setWindowState] = React.useState(() => ({
    ids: entries.map((entry) => entry.id),
    limit: count(initialVisible, Infinity),
  }));
  const ids = entries.map((entry) => entry.id);
  let limit = windowState.limit;
  if (
    ids.length !== windowState.ids.length ||
    ids.some((id, index) => id !== windowState.ids[index])
  ) {
    const oldFirst = windowState.ids[0],
      firstIndex = ids.indexOf(oldFirst),
      previous = new Set(windowState.ids);
    const prepended =
      firstIndex > 0
        ? ids.slice(0, firstIndex).filter((id) => !previous.has(id)).length
        : 0;
    limit += prepended;
    // Reconcile before committing the new list: existing entries never unmount
    // for a frame merely because a new update was prepended.
    setWindowState({ ids, limit });
  }
  const [announcement, setAnnouncement] = React.useState("");
  const visible = entries.slice(0, limit);
  const remaining = entries.length - visible.length;
  const nextPage = Math.min(remaining, count(pageSize, 3));

  // Days keep their identity across prepends and reveals, so their labels stay mounted.
  const [dayKeys, setDayKeys] = React.useState<Keys>(() => new Map());
  const dayRuns = runs(visible, (a, b) => a.group === b.group);
  const dayKeyList = keyGroups(dayRuns, dayKeys, "d:");
  const nextDayKeys = new Map(
    dayRuns.flatMap((day, i) => day.map((e) => [e.id, dayKeyList[i]] as const)),
  );
  if (!sameKeys(nextDayKeys, dayKeys)) setDayKeys(nextDayKeys);
  const items: React.ReactNode[] = [];
  dayRuns.forEach((day, i) => {
    const label = day[0].group;
    if (label)
      items.push(
        <GroupLabel key={`\u0001label:${dayKeyList[i]}`} label={label} />,
      );
    for (const group of runs(day, (a, b) => joins(layout, a, b)))
      group.forEach((entry, j) =>
        items.push(
          <Row
            key={entry.id}
            entry={entry}
            layout={layout}
            place={{
              first: j === 0,
              last: j === group.length - 1,
              dayEnd: entry === day[day.length - 1],
              size: group.length,
            }}
          />,
        ),
      );
  });

  const { quiet: globalQuiet } = useChoreography();
  const { quiet, enabled, inView } = useGuidanceMotion(section);
  const live = !quiet && enabled && inView;
  const scene = useActivityScene(section, {
    layout,
    ids: visible.map((entry) => entry.id),
    brand: new Set(visible.filter((e) => !e.actor).map((e) => e.id)),
    allowed: live,
    breathe: live,
    layer,
    takeRevealed: () => {
      const taken = revealed.current;
      revealed.current = [];
      return taken;
    },
  });

  React.useLayoutEffect(() => {
    if (focusIndex.current === null) return;
    const target = list.current?.querySelectorAll<HTMLElement>(
      "[data-activity-entry]:not([data-leaving])",
    )[focusIndex.current];
    // A revealed entry inside a closed burst opens its card, so focus lands on something visible.
    if (target && layout === "bursts") scene.current?.openCard(target);
    target?.focus();
    focusIndex.current = null;
  }, [visible.length, layout, scene]);

  const reveal = () => {
    focusIndex.current = visible.length;
    const nextCount = visible.length + nextPage;
    revealed.current = entries
      .slice(visible.length, nextCount)
      .map((entry) => entry.id);
    setWindowState((value) => ({ ...value, limit: nextCount }));
    setAnnouncement(`${nextCount} of ${entries.length} activities shown.`);
  };
  return (
    <section
      {...props}
      ref={setSection}
      data-slot="activity-feed"
      data-variant={layout}
      data-motion-quiet={globalQuiet || undefined}
      aria-label={ariaLabel ?? (!title && !labelledBy ? "Activity" : undefined)}
      aria-labelledby={labelledBy ?? (title ? titleId : undefined)}
      className={cn("v-activity-feed", className)}
    >
      {(title || description) && (
        <header className="v-activity-feed__header">
          {title && (
            <div className="v-activity-feed__heading">
              <Title id={titleId}>{title}</Title>
              <Badge
                variant="count"
                aria-label={`${entries.length} activities`}
              >
                {entries.length}
              </Badge>
            </div>
          )}
          {description && <BodySecondary as="div">{description}</BodySecondary>}
        </header>
      )}
      {entries.length === 0 ? (
        (empty ?? (
          <Empty>
            <EmptyTitle>No activity yet</EmptyTitle>
            <EmptyDescription>
              Updates appear here as they are added.
            </EmptyDescription>
          </Empty>
        ))
      ) : (
        <ActivitySceneContext.Provider value={scene}>
          <div className="v-activity-feed__body">
            <ol
              ref={list}
              id={listId}
              className="v-activity-feed__list"
              role="list"
            >
              <MotionPresence>
                {items}
              </MotionPresence>
            </ol>
            {layout === "thread" && (
              <svg
                ref={layer}
                className="v-activity-feed__thread"
                aria-hidden="true"
                focusable="false"
              />
            )}
          </div>
          {remaining > 0 && (
            <footer className="v-activity-feed__footer">
              <Button
                variant="secondary"
                size="sm"
                aria-controls={listId}
                onClick={reveal}
              >
                <AnimatedIcon name="chevron-down" size="sm" preset="bounce" />
                {showMoreLabel ?? `Show ${nextPage} more`}
              </Button>
              <Meta>
                {visible.length} of {entries.length}
              </Meta>
            </footer>
          )}
        </ActivitySceneContext.Provider>
      )}
      <span role="status" aria-live="polite" className="sr-only">
        {announcement}
      </span>
    </section>
  );
}
