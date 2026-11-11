#!/usr/bin/env python3
"""Read-only /proc CPU sample of loom listener services, including worker children."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import time


def processes(units):
    found = {}
    for unit in units:
        group = subprocess.check_output(
            ['systemctl', '--user', 'show', unit, '--property=ControlGroup', '--value'], text=True
        ).strip()
        if not group or group == '/':
            raise RuntimeError(f'{unit}: no service cgroup')
        for file in (Path('/sys/fs/cgroup') / group.lstrip('/')).rglob('cgroup.procs'):
            for pid in file.read_text().split():
                found[int(pid)] = unit
    return found


def read(pid):
    stat = Path(f'/proc/{pid}/stat').read_text().rsplit(') ', 1)[1].split()
    return int(stat[11]) + int(stat[12]), int(stat[19])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--seconds', type=float, default=60)
    parser.add_argument('--unit', action='append')
    parser.add_argument('--pid', type=int, action='append', help='sample explicit pids instead of service cgroups')
    args = parser.parse_args()
    if not 0 < args.seconds <= 3600:
        parser.error('--seconds must be in (0, 3600]')
    units = args.unit or ['loom-http.service', 'loom-http-lan.service', 'loom-http-local.service']
    pids = {pid: 'explicit' for pid in args.pid} if args.pid else processes(units)
    if not pids:
        raise RuntimeError('no processes found')
    before = {pid: read(pid) for pid in pids}
    started = time.monotonic()
    time.sleep(args.seconds)
    after = {pid: read(pid) for pid in pids}
    elapsed = time.monotonic() - started
    if not args.pid and processes(units) != pids:
        raise RuntimeError('service processes changed during sample; repeat on a stable release')
    results = []
    totals = {}
    for pid, unit in sorted(pids.items()):
        if before[pid][1] != after[pid][1]:
            raise RuntimeError(f'pid {pid} was reused; repeat sample')
        cpu = (after[pid][0] - before[pid][0]) / os.sysconf('SC_CLK_TCK') / elapsed * 100
        results.append({'unit': unit, 'pid': pid, 'cpu_percent_of_one_core': round(cpu, 3)})
        totals[unit] = totals.get(unit, 0) + cpu
    print(json.dumps({'elapsed_seconds': round(elapsed, 3), 'processes': results,
                      'unit_totals': {unit: round(cpu, 3) for unit, cpu in totals.items()}}, indent=2))


if __name__ == '__main__':
    main()
