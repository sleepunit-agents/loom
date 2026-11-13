import { it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startLoom } from './foundation.js';
import { fixtureSharing } from './fixture.js';
import { HouseholdRows } from './core/household/rows.js';

it('next approvals resolve current row-backed project rules and fail closed on unreadable metadata', async () => {
  const home = mkdtempSync(join(tmpdir(), 'loom-approvals-projects-'));
  writeFileSync(join(home, 'projects.json'), 'not json');
  const options = { home, next: true, sharing: fixtureSharing,
    authenticate: (req: import('node:http').IncomingMessage) => ({ viewer: req.headers.authorization === 'art' ? { kind: 'agent' as const, id: 'art' } : { kind: 'member' as const, id: 'jonathan' }, valid: () => true }) };
  let loom = await startLoom(options);
  let sequence = 0;
  const call = async (verb: string, input: object, who = 'jonathan') => {
    const response = await fetch(`${loom.url}/api/approvals/${verb}`, { method: 'POST',
      headers: { 'content-type': 'application/json', authorization: who }, body: JSON.stringify({ input, id: `project-${++sequence}` }) });
    return response.json();
  };
  const target = `github:acme/app#12@${'a'.repeat(40)}`;
  const rule = () => call('rule', { kind: 'merge', targets: [target], for: 'art' });
  const project = { slug: 'pond', name: 'Pond', repositories: ['github:acme/app'], members: [], agents: [] };
  try {
    expect(await call('set-rule', { kind: 'merge', scope: 'github:acme/*', tier: 'do' })).toMatchObject({ ok: true });
    expect(await call('set-rule', { kind: 'merge', scope: 'project:pond', tier: 'ask' })).toMatchObject({ ok: true });
    new HouseholdRows(loom.db, 'projects').put('pond', project);
    expect(await rule()).toMatchObject({ ok: true, value: { [target]: { tier: 'ask', scope: 'project:pond' } } });
    // Metadata is read per operation; removing a repo changes the next lookup.
    new HouseholdRows(loom.db, 'projects').put('pond', { ...project, repositories: [] });
    expect(await rule()).toMatchObject({ ok: true, value: { [target]: { tier: 'do', scope: 'github:acme/*' } } });
    new HouseholdRows(loom.db, 'projects').put('pond', project);
    await loom.close(); loom = await startLoom(options);
    expect(await rule()).toMatchObject({ ok: true, value: { [target]: { tier: 'ask', scope: 'project:pond' } } });
    new HouseholdRows(loom.db, 'projects').put('pond', { ...project, repositories: null });
    expect(await rule()).toMatchObject({ ok: true, value: { [target]: { tier: 'ask', note: expect.stringContaining("project list couldn't be read") } } });
    // A later repair is visible; malformed rows must not become an empty list.
    new HouseholdRows(loom.db, 'projects').put('pond', project);
    expect(await rule()).toMatchObject({ ok: true, value: { [target]: { tier: 'ask', scope: 'project:pond' } } });
    expect(await call('set-rule', { kind: 'merge', scope: 'project:pond', tier: 'do' })).toMatchObject({ ok: true });
    expect(await rule()).toMatchObject({ ok: true, value: { [target]: { tier: 'do', scope: 'project:pond' } } });
    // Repository metadata supplies no caller authority or owner view to a body.
    expect(await call('rule', { kind: 'merge', targets: [target], principal: 'owner', project: 'pond' }, 'art'))
      .toMatchObject({ ok: true, value: { [target]: { tier: 'ask', for: '?' } } });
    expect(await call('rule', { kind: 'merge', targets: [target], for: 'art' }, 'art'))
      .toMatchObject({ ok: false, code: 'denied' });
  } finally { await loom.close(); rmSync(home, { recursive: true, force: true }); }
});
