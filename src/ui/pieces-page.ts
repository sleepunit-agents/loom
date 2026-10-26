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
  PieceError, installPiece, managedBinDir, managedPieces, missingSettings, parseSource, piecesRoot, readCatalog, readSettings,
  removePiece, rollbackPiece, setSettings, type PieceRecord,
} from '../cli/pieces-managed.js';
import { unitName } from '../cli/pieces-services.js';
import type { ActResult, Ask, Block, Page } from './vocab.js';

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
  const buttons: { action: string; label: string; tone?: 'primary' | 'danger'; fields: Record<string, string> }[] = [];
  if (update) buttons.push({ action: 'piece-update', label: `Update to ${update.slice(0, 12)}`, tone: 'primary', fields: { name: r.name } });
  if (r.previous) buttons.push({ action: 'piece-rollback', label: `Roll back to ${r.previous.version || r.previous.commit.slice(0, 12)}`, fields: { name: r.name } });
  buttons.push({ action: 'piece-remove', label: 'Remove', tone: 'danger', fields: { name: r.name } });
  const blocks: Block[] = [
    { type: 'kv', items: [
      { label: 'version', value: r.version || '—' },
      { label: 'source', value: `${r.source.repo} @ ${r.source.commit.slice(0, 12)}` },
      { label: 'installed', value: r.installed.slice(0, 16).replace('T', ' ') + ' UTC' },
      ...(r.loom.services.length ? [{ label: 'services', value: r.loom.services.map((s) => unitName(r.name, s.name)).join(', ') }] : []),
    ] },
  ];
  if (missing.length) blocks.unshift({ type: 'callout', tone: 'warn', title: 'Needs setup', text: `Set ${missing.join(', ')} below.` });
  if (r.loom.settings.length) {
    blocks.push({
      type: 'form', action: 'piece-set', title: 'Settings', submit: 'Save settings', hidden: { name: r.name },
      note: 'Given to this piece alone, when loom runs it. Leave one empty to use its default (or the value loom-http already has).',
      fields: r.loom.settings.map((s) => ({
        name: fieldOf(s.name), label: `${s.label} (${s.name})`, kind: s.kind === 'choice' ? 'choice' as const : 'text' as const,
        ...(s.hint || s.default ? { hint: [s.hint, s.default ? `default: ${s.default}` : ''].filter(Boolean).join(' · ') } : {}),
        ...(values[s.name] ? { value: values[s.name] } : {}),
        ...(s.options ? { options: s.options } : {}),
      })),
    });
  }
  blocks.push({ type: 'buttons', items: buttons });
  return blocks;
}

export function piecesPage(env: NodeJS.ProcessEnv, query: Record<string, string> = {}): Page {
  const managed = new Map(managedPieces(env).map((r) => [r.name, r]));
  const catalog = readCatalog();
  const bin = managedBinDir(env);
  const installed = listPieces(env).filter((p) => p.name !== 'loom');
  const jobs = readJobs(env);

  const installedBlocks: Block[] = installed.length ? installed.map((p): Block => {
    const r = managed.get(p.name);
    if (r && bin && p.path.startsWith(bin + '/')) {
      const c = catalog.find((x) => x.name === r.name && x.repo === r.source.repo);
      const update = c && c.commit !== r.source.commit ? c.commit : undefined;
      const missing = missingSettings(env, r);
      return { type: 'details', summary: r.loom.label ?? c?.label ?? r.name,
        meta: [r.version, update ? 'update available' : '', missing.length ? 'needs setup' : ''].filter(Boolean).join(' · '),
        blocks: managedBlocks(env, r, update) };
    }
    return { type: 'callout', title: p.name, text: `${p.path} — on PATH, not installed by loom, so it's managed by hand.`, tone: 'muted' };
  }) : [{ type: 'text', text: 'No pieces yet. Install one below.', tone: 'muted' }];

  const available = catalog.filter((c) => !managed.has(c.name) && !installed.some((p) => p.name === c.name));
  const sections: Page['sections'] = [];
  if (jobs.length) {
    sections.push({ id: 'jobs', title: 'Installs', tone: jobs[0].state === 'running' ? 'warn' : undefined, blocks: [{ type: 'list', items: jobs.map((j) => ({
      text: j.label, badge: j.state, tone: j.state === 'failed' ? 'bad' as const : j.state === 'running' ? 'warn' as const : 'ok' as const,
      meta: [j.started.slice(0, 16).replace('T', ' ') + ' UTC', j.message].filter(Boolean).join(' · '),
    })) }] });
  }
  sections.push({ id: 'installed', title: 'Installed', blocks: installedBlocks.slice(0, 20) });
  sections.push({ id: 'available', title: 'Available', blocks: available.length
    ? available.slice(0, 19).flatMap((c): Block[] => [
      { type: 'callout', title: c.label ?? c.name, text: `${c.description ?? ''} (${c.repo} @ ${c.commit.slice(0, 12)})`.trim() },
      { type: 'buttons', items: [{ action: 'piece-install', label: `Install ${c.label ?? c.name}`, tone: 'primary', fields: { name: c.name } }] },
    ]).slice(0, 20)
    : [{ type: 'text', text: 'Everything in loom\'s catalog is installed.', tone: 'muted' }] });

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
        { type: 'buttons', items: [{ action: 'piece-install', label: 'Install anyway', tone: 'danger', fields: { repo, commit, confirm: 'yes' } }] },
      );
    }
  }
  sections.push({ id: 'github', title: 'From GitHub', side: true, blocks: github });
  return { title: 'Pieces', intro: 'What loom runs beside itself: install, update, roll back and remove them here.', sections };
}

/** "Your call" items: managed pieces still missing a required setting. */
export function piecesAsks(env: NodeJS.ProcessEnv): Ask[] {
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
        const c = readCatalog().find((x) => x.name === name && x.repo === r?.source.repo);
        if (!r || !c) return { ok: false, message: `${name} has no update in loom's catalog.`, page: 'loom:pieces' };
        return startJob(env, `Update ${r.loom.label ?? r.name}`, async () => {
          const u = await installPiece(env, { repo: c.repo, commit: c.commit }, r.name);
          return `now ${u.record.version} (${c.commit.slice(0, 12)})`;
        });
      }
      case 'piece-rollback': {
        const r = rollbackPiece(env, name);
        return { ok: true, message: `${r.loom.label ?? r.name} is back on ${r.version || r.source.commit.slice(0, 12)}.`, page: 'loom:pieces' };
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
