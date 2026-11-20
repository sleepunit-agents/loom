import { expect, it, vi } from 'vitest';
import fs from 'node:fs';
import subprocess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
// Importing the database or foundation through this pure entry point must fail.
vi.mock('../../core/index.js', () => { throw new Error('Forbidden database dependency'); });
vi.mock('../../core/db/index.js', () => { throw new Error('Forbidden database dependency'); });
vi.mock('better-sqlite3', () => { throw new Error('Forbidden database dependency'); });
import { planLegacySecretRecords } from './import-records.js';

it('plans destination records without filesystem, subprocess, database or implicit clock', () => {
  const at = '2020-01-01T00:00:00.000Z';
  const policy = Buffer.from('{}');
  const request = Buffer.from(JSON.stringify({ v: 1, requests: {
    'q-01234567': { id: 'q-01234567', secret: 'API', agent: 'old-art', house: 'h-1', why: 'work', minutes: 60,
      at, state: 'granted', by: 'owner', who: 'old-dana', decided: at, expires: '2020-01-01T01:00:00.000Z' },
  } }));
  const principals = { bindings: new Map([['old-art', 'art']]), registered: new Set(['art']),
    members: new Map([['old-dana', 'dana']]), registeredMembers: new Set(['dana']) };
  const forbidden = () => { throw new Error('Forbidden planning side effect'); };
  const files = (['readFileSync', 'writeFileSync', 'openSync', 'appendFileSync', 'readdirSync', 'statSync'] as const)
    .map(name => vi.spyOn(fs, name).mockImplementation(forbidden));
  const processes = (['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'] as const)
    .map(name => vi.spyOn(subprocess, name).mockImplementation(forbidden));
  const NativeDate = Date;
  const clock = vi.fn(function (...args: unknown[]) {
    if (!args.length) throw new Error('Forbidden implicit current clock');
    return Reflect.construct(NativeDate, args);
  });
  Object.assign(clock, { parse: NativeDate.parse, UTC: NativeDate.UTC, now: forbidden });
  vi.stubGlobal('Date', clock); syncBuiltinESMExports();
  try {
    expect(planLegacySecretRecords(policy, request, principals, new Set(['API']), NativeDate.parse(at)).grants)
      .toMatchObject([{ by: 'dana', scope: { house: 'h-1' } }]);
    expect(clock).not.toHaveBeenCalled();
    for (const call of [...files, ...processes]) expect(call).not.toHaveBeenCalled();
  } finally { vi.unstubAllGlobals(); vi.restoreAllMocks(); syncBuiltinESMExports(); }
});
