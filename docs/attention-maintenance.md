# Attention maintenance

The in-process Attention daemon runs wait checks on demand and while waits remain,
and retention at startup and daily. It uses the core clock; close cancels both
schedules before the database closes. No host timer or extra process is needed.

`attention.sweepWaits` and `attention.retain` scan at most 1000 inventory rows per
call, with one lookahead row. Both accept an optional numeric `after` cursor and
return `next` only when another page remains. Cursors are SQLite row positions,
not record ids or authorization. Callers continue with `{ after: next }` and a
fresh operation id. Replaying a write id replays that page's receipt.
Existing small calls with `{}` keep their result shape. Totals are per page.

The daemon schedules each next page at the current core-clock time, which defers
to another event-loop turn. Each page commits separately, rereads policy, and
fetches new owning-role facts under the original viewer. Only the cursor and
pending count survive the yield. A failed page ends the pass and retries from the
start on the normal cadence; committed pages remain committed. Ask changes during
a pass request a fresh pass, so changes behind the cursor are not lost. Empty
inventories stop wait polling until a live ask change wakes it.

The bound is on inventory rows, including hidden and ineligible records, rather
than eligible results. Wait task reads remain one batch per page (10 and 1000 waits
both use one batch). Retention keeps each conversation's complete UTC-day fold
atomic, preserving exact median latency and counts. The work inside a single
conversation remains proportional to its retained turns; this is not a wall-clock
or per-turn bound. A very large conversation may still stall one page. No message
text is read, and no policy or task snapshot is cached across turns.
