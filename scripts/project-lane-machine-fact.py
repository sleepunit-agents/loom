#!/usr/bin/env python3
"""Project a complete operator-supplied source to one compact JSON fact on stdout.

Input is an unrotated JSONL ledger or the output of Art's taskstore-mirror-check.
Publish stdout by atomic rename only on exit zero. Run outside the worker.
"""
import argparse
from collections import Counter, deque
import json
import math
import re
import sys
import time

DAY = 86400
MAX_BYTES = 128 * 1024 * 1024
MAX_LINE = 256 * 1024
MAX_OUTPUT = 16384
REASONS = {
    'outside-scope-or-primary', 'missing-symlink-locked-or-prunable',
    'protected-branch', 'open-pr', 'no-exact-merged-pr', 'head-changed',
    'dirty', 'ignored-data', 'git-lock', 'recent', 'in-use-or-unreadable-process',
    'registration-changed', 'error',
}
ALERT_KINDS = {'unit', 'page','unit-suppressed', 'message', 'triage', 'triage-joined','triage-skipped',
               'clear', 'alert', 'verdict'}


def records(stream):
    total = 0
    while line := stream.readline(MAX_LINE + 1):
        total += len(line)
        if total > MAX_BYTES or len(line) > MAX_LINE or not line.endswith(b'\n'):
            raise ValueError()
        yield json.loads(line)


def project(kind, stream, now):
    result = {'observedAt': now}
    if kind == 'mirror-unit-state':
        raw = stream.read(513)
        if len(raw) > 512:
            raise ValueError()
        fields = dict(line.split('=', 1) for line in raw.decode('ascii').splitlines())
        if set(fields) != {'Id', 'LoadState', 'ActiveState', 'SubState', 'Result'}:
            raise ValueError()
        if fields.pop('Id') != 'art-live-sync.service':
            raise ValueError()
        if not all(re.fullmatch(r'[a-z][a-z0-9-]{0,39}', value) for value in fields.values()):
            raise ValueError()
        return dict(result, **fields)
    if kind == 'login-expiry':
        raw = stream.read(65537)
        if len(raw) > 65536:
            raise ValueError()
        expiry = json.loads(raw)['claudeAiOauth']['refreshTokenExpiresAt']
        if type(expiry) is not int:
            raise ValueError()
        if expiry > 10**10:
            expiry //= 1000
        if not 0 < expiry <= 253402300799:
            raise ValueError()
        return dict(result, refreshExpiresAt=expiry)
    if kind == 'mirror-freshness':
        # The checker emits its counts on stdout on both fresh and stale results.
        raw = stream.read(257)
        match = re.fullmatch(rb'tracked max: t-(\d+)  live max: t-([1-9]\d*)  drift: (-?\d+)\n(?:OK\n)?', raw)
        if not match or len(raw) > 256:
            raise ValueError()
        tracked, live, drift = map(int, match.groups())
        if live - tracked != drift:
            raise ValueError()
        return dict(result, trackedMax=tracked, liveMax=live)

    if kind == 'cleanup-week-journal':
        since = now - 7 * DAY
        recent = deque(maxlen=100)
        total = 0
        for row in records(stream):
            if row.get('_SYSTEMD_USER_UNIT') != 'art-worktree-cleanup.service':
                raise ValueError()
            at = int(row['__REALTIME_TIMESTAMP']) // 1000000
            priority = int(row['PRIORITY'])
            if at > now or not 0 <= priority <= 7:
                raise ValueError()
            if at >= since:
                total += 1
                recent.append(dict(at=at, priority=priority))
        return dict(result, since=since, total=total, recent=list(recent))
    alerts = kind == 'alert-ledger'
    since = now - (26 * 3600 if alerts else 7 * DAY)
    result['since'] = since
    counts = Counter()
    reasons = Counter()
    false_causes = Counter()
    entries = []
    runs = []
    removed_heads = []
    for row in records(stream):
        at = row['ts' if alerts else 'at']
        if type(at) not in (int, float) or not math.isfinite(at) or at <= 0 or int(at) > now:
            raise ValueError()
        if (alerts and at > now - 30 * DAY and row.get('kind') == 'verdict'
                and row.get('verdict') == 'false-alarm'):
            cause = row.get('cause', '')
            if not isinstance(cause, str):
                raise ValueError()
            false_causes[row['source'], ' '.join(cause.lower().split())] += 1
        if at < since:
            continue
        if alerts:
            event = row['kind']
            if event not in ALERT_KINDS or len(entries) == 100:
                raise ValueError()
            entry = {'at': int(at), 'kind': event, 'source': row['source']}
            ident = row.get('id') or row.get('alert')
            if ident:
                entry['id'] = ident
            if not all(re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.:@-]{0,95}', value)
                       for value in (entry['source'], *([ident] if ident else []))):
                raise ValueError()
            if event == 'verdict':
                if row['verdict'] not in ('fixed', 'false-alarm', 'real'):
                    raise ValueError()
                entry['verdict'] = row['verdict']
            entries.append(entry)
        else:
            action = row.get('event') or row['action']
            if action not in ('start', 'finish', 'removed', 'keep', 'would-remove'):
                raise ValueError()
            counts[action] += 1
            if action in ('start', 'finish'):
                if (len(runs) >= 100 or type(row['count']) is not int or row['count'] < 0
                        or type(row['apply']) is not bool):
                    raise ValueError()
                runs.append(dict(at=int(at), event=action, count=row['count'], apply=row['apply']))
            if action == 'removed':
                head = row['head']
                if len(removed_heads) >= 100 or not re.fullmatch(r'[a-f0-9]{40}', head):
                    raise ValueError()
                removed_heads.append(head)
            if action == 'keep':
                if row['reason'] not in REASONS:
                    raise ValueError()
                reasons[row['reason']] += 1
    if alerts:
        active = {entry['source'] for entry in entries}
        tune = sorted({source for (source, _), n in false_causes.items() if source in active and n >= 2})
        return dict(result, entries=entries, tuneSources=tune)
    return dict(result, started=counts['start'], finished=counts['finish'],
                kept=counts['keep'], removed=counts['removed'],
                wouldRemove=counts['would-remove'], reasons=dict(reasons), runs=runs, removedHeads=removed_heads)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('kind', choices=['mirror-freshness', 'alert-ledger', 'cleanup-receipt', 'login-expiry', 'cleanup-week-journal', 'mirror-unit-state'])
    args = parser.parse_args()
    try:
        result = project(args.kind, sys.stdin.buffer, int(time.time()))
        encoded = json.dumps(result, separators=(',', ':'), allow_nan=False)
        if len(encoded) + 1 > MAX_OUTPUT:
            raise ValueError()
    except (ValueError, TypeError, KeyError, OSError, OverflowError, RecursionError):
        sys.exit('Incomplete, oversized, or unrecognized machine fact input')
    print(encoded)
