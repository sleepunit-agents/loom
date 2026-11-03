/**
 * The Pieces page (docs/specs/pieces-install.md, "The Pieces page"): what's
 * installed, what loom's catalog offers, and a GitHub repo and commit for
 * anything else. loom draws it like People, and it's the owner's: the page as
 * a whole is.
 *
 * An install takes longer than an action may, so the action starts it here,
 * in the daemon, and returns; the page shows it running from `jobs` until
 * it's done. One install at a time.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { listPieces } from '../cli/pieces.js';
import {
  PieceError, describeSource, installPiece, isLocal, versionKey, managedBinDir, managedPieces, missingSettings, parseSource, piecesRoot, readCatalog, readSettings,
  removePiece, renamedAdvice, rollbackPiece, setSettings, type PieceRecord,
} from '../cli/pieces-managed.js';
import { unitName } from '../cli/pieces-services.js';
import type { ActResult, Ask, Block, Page, PanelRow } from './vocab.js';
import { uiTimeZone, when } from './core.js';

interface Job {
  label: string;
  state: 'running' | 'done' | 'failed';
  started: string;
  ended?: string;
  message?: string;
}

let running: Promise<void> | null = null;

function jobsFile(env: NodeJS.ProcessEnv): string | undefined {
  const root = piecesRoot(env);
  return root ? join(root, 'jobs.json') : undefined;
}

function readJobs(env: NodeJS.ProcessEnv): Job[] {
  const f = jobsFile(env);
  if (!f) return [];
  try {
    const j = JSON.parse(readFileSync(f, 'utf-8'));
    const jobs = Array.isArray(j) ? (j as Job[]) : [];
    // One the daemon isn't running any more (it restarted mid-install) didn't finish.
    return jobs.map((x) => (x.state === 'running' && !running ? { ...x, state: 'failed' as const, message: 'interrupted: loom restarted during the install' } : x));
  } catch {
    return [];
  }
}

function writeJobs(env: NodeJS.ProcessEnv, jobs: Job[]): void {
  const f = jobsFile(env);
  if (!f) return;
  mkdirSync(piecesRoot(env)!, { recursive: true });
  writeFileSync(f, JSON.stringify(jobs.slice(0, 5), null, 2) + '\n');
}

/** Start `work` in the background unless an install is already running. */
function startJob(env: NodeJS.ProcessEnv, label: string, work: () => Promise<string>): ActResult {
  if (running) return { ok: false, message: 'Another install is running; wait for it to finish.', page: 'loom:pieces' };
  const job: Job = { label, state: 'running', started: new Date().toISOString() };
  writeJobs(env, [job, ...readJobs(env)]);
  const finish = (state: Job['state'], message: string) => {
    const [, ...rest] = readJobs(env);
    writeJobs(env, [{ ...job, state, message, ended: new Date().toISOString() }, ...rest]);
  };
  running = work()
    .then((m) => finish('done', m), (err: Error) => finish('failed', err instanceof PieceError ? err.message : `failed: ${err.message}`))
    .finally(() => { running = null; });
  return { ok: true, message: `${label}: started. It takes from a few seconds to a few minutes; reload this page to see it finish.`, page: 'loom:pieces' };
}

/** For tests: wait for the install that's running, if any. */
export async function settled(): Promise<void> {
  await running;
}

const fieldOf = (setting: string) => `s_${setting.toLowerCase()}`.slice(0, 40);

function managedBlocks(env: NodeJS.ProcessEnv, r: PieceRecord, update?: string): Block[] {
  const missing = missingSettings(env, r);
  const values = readSettings(env, r.name);
  // A piece's own panel (Jonathan, 2026-11-03: "app panels, not web forms"): what it is now, in rows; its settings in a
  // sheet; updating, rolling back and removing as a tap each. Its commit and services are details, quiet in a row.
  const rows: PanelRow[] = [
    { label: 'Version', value: r.version || 'No version', detail: describeSource(r.source).replace('@', ' @ ') },
    { label: 'Installed', value: when(r.installed, uiTimeZone()) },
    ...(r.loom.services.length ? [{ label: 'Runs in the background', value: r.loom.services.map((x) => unitName(r.name, x.name)).join(', ') }] : []),
  ];
  if (r.loom.settings.length) {
    rows.push({
      label: 'Settings', tone: missing.length ? 'warn' : undefined,
      value: missing.length ? `Needs ${missing.join(', ')}` : `${r.loom.settings.length} set`,
      edit: {
        action: 'piece-set', title: 'Settings', submit: 'Save settings', hidden: { name: r.name },
        note: 'Given to this piece alone, when loom runs it. Leave one empty to use its default (or the value loom-http already has).',
        fields: r.loom.settings.map((x) => ({
          name: fieldOf(x.name), label: x.label, kind: x.kind === 'choice' ? 'choice' as const : 'text' as const,
          hint: [x.hint, x.default ? `Default: ${x.default}` : '', x.name].filter(Boolean).join(' · '),
          ...(values[x.name] ? { value: values[x.name] } : {}),
          ...(x.options ? { options: x.options } : {}),
        })),
      },
    });
  }
  if (update) rows.push({ label: 'Update', value: `A newer version is in loom's catalog (${update.slice(0, 7)})`, act: { action: 'piece-update', label: 'Update', tone: 'primary', fields: { name: r.name } } });
  // A local piece can't know it has an update until its directory is read again.
  else if (isLocal(r.source)) rows.push({ label: 'Update', value: 'From its directory, as it is now', act: { action: 'piece-update', label: 'Update', fields: { name: r.name } } });
  if (r.previous) rows.push({ label: 'Roll back', value: `To ${r.previous.version || r.previous.commit.slice(0, 7)}`, act: { action: 'piece-rollback', label: 'Roll back', fields: { name: r.name } } });
  rows.push({ label: 'Remove', value: 'Its program and service go; its settings and data stay, for a reinstall.',
    act: { action: 'piece-remove', label: 'Remove', tone: 'danger', confirm: 'Its program and service go. Its settings and data stay, for a reinstall.', fields: { name: r.name } } });
  return [{ type: 'panel', rows }];
}

export function piecesPage(env: NodeJS.ProcessEnv, query: Record<string, string> = {}): Page {
  const managed = new Map(managedPieces(env).map((r) => [r.name, r]));
  const catalog = readCatalog();
  const bin = managedBinDir(env);
  const installed = listPieces(env).filter((p) => p.name !== 'loom');
  const jobs = readJobs(env);

  // Installed, as an app store's Updates: a row a piece saying how it is, its panel a tap away.
  const pieceRows: PanelRow[] = [];
  let updates = 0, needs = 0;
  for (const p of installed) {
    const owner = [...managed.values()].find((x) => x.bins.includes(`loom-${p.name}`));
    // A bin that's part of another managed piece is shown with it, not on its own.
    if (owner && owner.name !== p.name && bin && p.path.startsWith(bin + '/')) continue;
    const r = managed.get(p.name);
    if (!(r && bin && p.path.startsWith(bin + '/'))) continue;
    const src = r.source;
    const c = isLocal(src) ? undefined : catalog.find((x) => x.name === r.name && x.repo === src.repo);
    const update = c && !isLocal(src) && c.commit !== src.commit ? c.commit : undefined;
    const missing = missingSettings(env, r);
    if (update) updates++;
    if (missing.length) needs++;
    const label = r.loom.label ?? c?.label ?? r.name.charAt(0).toUpperCase() + r.name.slice(1);
    pieceRows.push({
      label, tone: missing.length ? 'warn' : update ? 'muted' : 'ok',
      value: missing.length ? 'Needs setup' : update ? 'Update available' : 'Up to date',
      detail: [r.version ? `Version ${r.version}` : '', isLocal(src) ? 'From a folder on this machine' : '', c?.description ?? ''].filter(Boolean).join(' · ') || undefined,
      sheet: { title: label, blocks: [...(c?.description ? [{ type: 'text' as const, text: c.description }] : []), ...managedBlocks(env, r, update)] },
    });
  }
  const installedBlocks: Block[] = pieceRows.length ? [
    { type: 'health', tone: needs ? 'warn' : updates ? 'muted' : 'ok', text: needs ? `${needs} need${needs === 1 ? 's' : ''} setup` : updates ? `${updates} update${updates === 1 ? '' : 's'} available` : 'All up to date',
      detail: `${pieceRows.length} piece${pieceRows.length === 1 ? '' : 's'} installed` },
    { type: 'panel', rows: pieceRows.slice(0, 200) },
  ] : [{ type: 'text', text: 'No pieces yet. Install one below.', tone: 'muted' }];
  // Pieces on PATH that loom didn't install: one quiet list, the path a tap away in its meta.
  const byHand = installed.filter((p) => !(bin && p.path.startsWith(bin + '/')));
  const shown = pieceRows.length;

  const available = catalog.filter((c) => !managed.has(c.name) && !installed.some((p) => p.name === c.name));
  if (!installedBlocks.length) installedBlocks.push({ type: 'text', text: 'No pieces yet. Install one below.', tone: 'muted' });
  const sections: Page['sections'] = [];
  if (jobs.length) {
    sections.push({ id: 'jobs', title: 'Installs', tone: jobs[0].state === 'running' ? 'warn' : undefined, blocks: [{ type: 'list', items: jobs.map((j) => ({
      text: j.label, badge: j.state, tone: j.state === 'failed' ? 'bad' as const : j.state === 'running' ? 'warn' as const : 'ok' as const,
      meta: [when(j.started, uiTimeZone()), j.message].filter(Boolean).join(' · '),
    })) }] });
  }
  sections.push({ id: 'installed', title: shown ? `Installed · ${shown}` : 'Installed', blocks: installedBlocks.slice(0, 20) });
  // The board's catalog: a row a piece, Install at its right.
  sections.push({ id: 'available', title: 'Catalog', blocks: available.length
    ? [{ type: 'list', items: available.slice(0, 200).map((c) => ({
        text: c.label ?? c.name, meta: c.description ?? `${c.repo} @ ${c.commit.slice(0, 12)}`,
        act: { action: 'piece-install', label: 'Install', fields: { name: c.name } } })) }]
    : [{ type: 'text', text: 'Everything in loom\'s catalog is installed.', tone: 'muted' }] });
  // Pieces on PATH that loom didn't install: loom runs them, but doesn't update or remove them.
  if (byHand.length) {
    sections.push({ id: 'by-hand', title: `Managed by hand · ${byHand.length}`, side: true, blocks: [
      { type: 'list', items: byHand.map((p) => ({ text: p.name, meta: env.HOME && p.path.startsWith(`${env.HOME}/`) ? `~${p.path.slice(env.HOME.length)}` : p.path })) },
      { type: 'text', text: 'On PATH, not installed by loom: it runs them, but updating and removing them is yours.', tone: 'muted' },
    ] });
  }

  const repo = query.repo ?? '';
  const commit = query.commit ?? '';
  const github: Block[] = [{
    type: 'form', action: 'piece-preview', title: 'Install from GitHub', submit: 'Look at it first',
    note: 'A public repo and a full 40-character commit: a branch or tag can move.',
    fields: [
      { name: 'repo', label: 'Repo', kind: 'text', hint: 'owner/repo', required: true, ...(repo ? { value: repo } : {}) },
      { name: 'commit', label: 'Commit', kind: 'text', required: true, ...(commit ? { value: commit } : {}) },
    ],
  }];
  if (repo && commit) {
    let ok = true;
    try { parseSource(`github:${repo}#${commit}`); } catch (err) {
      ok = false;
      github.unshift({ type: 'callout', tone: 'bad', text: (err as Error).message });
    }
    if (ok) {
      github.unshift(
        { type: 'callout', tone: 'warn', title: `${repo} @ ${commit.slice(0, 12)} isn't in loom's catalog`,
          text: 'A piece runs as loom\'s own user, with what loom can reach, and npm runs its build scripts while it installs: installing it is running it. Only go on if you trust whoever wrote it with this machine.' },
        { type: 'link', text: 'Read it on GitHub first', href: `https://github.com/${repo}/tree/${commit}` },
        { type: 'buttons', items: [{ action: 'piece-install', label: 'Install anyway', tone: 'danger', confirm: 'It runs as you, with your files. Only install code you trust.', fields: { repo, commit, confirm: 'yes' } }] },
      );
    }
  }
  sections.push({ id: 'github', title: 'From GitHub', side: true, blocks: github });
  // While an install runs, the page reloads itself to show it finish.
  return { title: 'Pieces', intro: 'What loom runs beside itself: install, update, roll back and remove them here.', sections,
    ...(jobs[0]?.state === 'running' ? { refresh: 3 } : {}) };
}

/** "Your call" items: managed pieces still missing a required setting. */
export function piecesAsks(env: NodeJS.ProcessEnv): Ask[] {
  // Setting a piece up is a household owner's; an agent owner's page doesn't ask them (docs/specs/owners.md).
  if (env.LOOM_OWNER_SCOPE) return [];
  return managedPieces(env).flatMap((r) => {
    const missing = missingSettings(env, r);
    return missing.length ? [{ text: `Finish setting up ${r.loom.label ?? r.name}`, meta: `needs ${missing.join(', ')}`, page: 'loom:pieces', label: 'Set up' }] : [];
  }).slice(0, 10);
}

/** The Pieces page's actions. */
export async function piecesAct(env: NodeJS.ProcessEnv, action: string, fields: Record<string, string>): Promise<ActResult> {
  const name = fields.name ?? '';
  try {
    switch (action) {
      case 'piece-preview': {
        const repo = (fields.repo ?? '').trim().replace(/^https:\/\/github\.com\//, '').replace(/\/$/, '');
        const commit = (fields.commit ?? '').trim();
        return { ok: true, message: 'Read the warning before you install it.', page: `loom:pieces?repo=${encodeURIComponent(repo)}&commit=${encodeURIComponent(commit)}` };
      }
      case 'piece-install': {
        if (fields.repo !== undefined) {
          if (fields.confirm !== 'yes') return { ok: false, message: 'Installing from GitHub needs the confirmation on the page.', page: 'loom:pieces' };
          const source = parseSource(`github:${fields.repo}#${fields.commit ?? ''}`);
          return startJob(env, `Install ${source.repo} @ ${source.commit.slice(0, 12)}`, async () => {
            const r = await installPiece(env, source);
            return `installed ${r.record.name} ${r.record.version}`;
          });
        }
        const c = readCatalog().find((x) => x.name === name);
        if (!c) return { ok: false, message: `${name} isn't in loom's catalog.`, page: 'loom:pieces' };
        return startJob(env, `Install ${c.label ?? c.name}`, async () => {
          const r = await installPiece(env, { repo: c.repo, commit: c.commit }, c.name);
          return [`installed ${r.record.version}`, r.missing.length ? `it needs ${r.missing.join(', ')}` : '', ...r.services.notes].filter(Boolean).join('; ');
        });
      }
      case 'piece-update': {
        const r = managedPieces(env).find((x) => x.name === name);
        if (r && isLocal(r.source)) {
          const path = r.source.path;
          return startJob(env, `Update ${r.loom.label ?? r.name} from ${path}`, async () => {
            const u = await installPiece(env, { path }, r.name);
            return u.unchanged ? `nothing in ${path} changed` : `now ${u.record.version} (${describeSource(u.record.source)})`;
          });
        }
        const renamed = r ? renamedAdvice(r) : undefined;
        if (renamed) return { ok: false, message: renamed, page: 'loom:pieces' };
        const repo = r && !isLocal(r.source) ? r.source.repo : undefined;
        const c = readCatalog().find((x) => x.name === name && x.repo === repo);
        if (!r || !c) return { ok: false, message: `${name} has no update in loom's catalog.`, page: 'loom:pieces' };
        return startJob(env, `Update ${r.loom.label ?? r.name}`, async () => {
          const u = await installPiece(env, { repo: c.repo, commit: c.commit }, r.name);
          return `now ${u.record.version} (${c.commit.slice(0, 12)})`;
        });
      }
      case 'piece-rollback': {
        const r = rollbackPiece(env, name);
        return { ok: true, message: `${r.loom.label ?? r.name} is back on ${r.version || versionKey(r.source).slice(0, 12)}.`, page: 'loom:pieces' };
      }
      case 'piece-remove': {
        removePiece(env, name);
        return { ok: true, message: `Removed ${name}. Its settings and data are kept, so installing it again picks up where it was.`, page: 'loom:pieces' };
      }
      case 'piece-set': {
        const r = managedPieces(env).find((x) => x.name === name);
        if (!r) return { ok: false, message: `${name} isn't installed by loom.`, page: 'loom:pieces' };
        const values: Record<string, string> = {};
        for (const s of r.loom.settings) {
          const v = fields[fieldOf(s.name)];
          if (v !== undefined) values[s.name] = v.trim();
        }
        setSettings(env, name, values);
        const missing = missingSettings(env, r);
        return { ok: true, message: missing.length ? `Saved. Still needed: ${missing.join(', ')}.` : 'Saved. The piece gets them the next time loom runs it.', page: 'loom:pieces' };
      }
    }
    return { ok: false, message: `loom has no action "${action}".` };
  } catch (err) {
    if (err instanceof PieceError) return { ok: false, message: err.message, page: 'loom:pieces' };
    throw err;
  }
}
