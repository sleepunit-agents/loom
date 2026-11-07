/**
 * `loom household`, `loom token` and `loom sessions` (docs/specs/household.md,
 * docs/specs/passkeys.md). Local only: none is a remote verb, so they never run through /cli. They read and
 * write $LOOM_HOME (default ~/.config/loom) directly.
 */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import {
  addAgent, agentDir, moveKnowledgeToCommons, createToken, householdHome, HouseholdError, initHousehold, loadHousehold, loadTokens,
  expired, parseRole, revokeToken, checkSpriteManifest, manifestFromPixelLab, setSprite, spriteOf, type Household,
} from '../household.js';
import { iconSetName, iconSetOf, installedIconSets, installIconSet, setIcon, useIconSet } from '../icon-set.js';
import { splitPeopleIntoCommons } from '../backends/people-household.js';
import { runtimePieces } from './pieces-managed.js';
import type { IOStreams } from './io.js';
import { extractGlobalFlags, parseVerb, type VerbOptions } from './args.js';
import { REF, SESSION_MAX_AGE_S, sessionStore, signinLink } from '../ui/sessions.js';

const HOUSEHOLD_USAGE = `Usage: loom household <command>

  show                     The household at $LOOM_HOME: agents, the default, the owner
  init <agent> [--owner <name>]
                           Make $LOOM_HOME/<agent> (a context dir) the first agent of a new
                           household: it moves to agents/<agent>, and a symlink stays behind
  add <agent>              Add an agent whose directory already exists under agents/
  sprite <agent> <sheet.png> <pixellab.json> [--weight <state>=<n>]... [--variant "<animation>=<state>:<weight>[:rare]"]...
                           Give an agent a pixel face from a PixelLab export: its sheet, and a
                           manifest seeded from its rows (each state in each facing, weight 1
                           unless --weight; waiting south only; another named animation only
                           where --variant places it), kept at faces/<agent>/
  sprite <agent> --manifest <manifest.json> [<name.png>...]
                           Replace its manifest (states, facings, animations and their weights;
                           see docs/specs/household.md), with any sheets it names that are new
  icons install <dir> [--name <set>]
                           Install a pixel icon set and wear it: <dir>'s manifest.json, or every
                           <app>.png in it (32×32, e.g. home.png, inbox.png), kept at icons/<set>/.
                           Members see it with Appearance's "Pixel icons" on
  icons set <app> <file.png>
                           Give one app of the set in use a new icon
  icons use <set>|none     Wear another installed set, or none
  icons list               The sets installed, and the one in use
  commons                  Move the default agent's knowledge.db to commons/knowledge.db and
                           split every agent's person cards (handles and facts to the commons
                           directory, the rest stays as its relationships). Once, with
                           every loom daemon on this household stopped

$LOOM_HOME defaults to ~/.config/loom.
`;

const TOKEN_USAGE = `Usage: loom token <command>

  create (--agent <name> [--service <name>] [--house <h-N>] | --owner | --peer <name> | --piece <piece>/<subject> | --runtime <piece>) --label <text>
                           Mint a token. It's printed once; only its sha256 is kept.
                           --service and --house name a house's (agent:<name>/<service>@<house>): a piece can tell it apart
  list                     Every token: label, role, created, last used, revoked
  revoke <label>           Revoke the live token with that label (takes effect on the next request)
  link [--minutes 10] [--page-url <loom's page address>] [--label <text>]
                           A one-time link that signs a browser in to the page (no token to paste).
                           Its sessions are the owner token "page sign-in links": revoke that to end them
                           all, or one alone with \`loom sessions revoke\`. --label names the session it
                           opens (an agent's screenshots: --label "screenshots t-1871")

Roles: agent:<name> is MCP and the CLI as that agent; owner sees everything and
the page; peer:<name> reaches commons knowledge only; piece:<piece>/<subject> is
a piece's own credential (e.g. a box's), reaching only POST /api/<piece>/.
runtime:<piece> is the runtime piece's (the one managed piece whose loom block
says "role": "runtime"), reaching only its own POST /api/loom/ routes. A review
token (review:<piece>) isn't made here: the runtime mints one per run, through
POST /api/loom/review/token, and it expires in two hours.
`;

/**
 * The verb, and the argv after it, or the exit code when there's nothing to run: no verb or --help prints
 * usage (0), an unknown verb is refused (2). Each verb then parses its own flags with parseVerb before it
 * touches anything (t-1950: \`loom token link --help\` minted a live sign-in link).
 */
function verbOf(argv: string[], verbs: readonly string[], usage: string, io: IOStreams): { sub: string; rest: string[] } | number {
  const { rest: args } = extractGlobalFlags(argv);
  const [sub, ...rest] = args;
  if (sub === undefined || sub === '--help' || sub === '-h') { io.stdout(usage); return 0; }
  if (!verbs.includes(sub)) { io.stderr(`Unknown command: ${sub}\n${usage}`); return 2; }
  return { sub, rest };
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

function need(io: IOStreams): Household | null {
  const home = householdHome(io.env);
  const h = loadHousehold(home);
  if (!h) io.stderr(`No household at ${home} (no household.json). Make one with: loom household init <agent>\n`);
  return h;
}

export async function runHousehold(argv: string[], io: IOStreams): Promise<number> {
  const verb = verbOf(argv, ['show', 'init', 'commons', 'add', 'sprite', 'icons'], HOUSEHOLD_USAGE, io);
  if (typeof verb === 'number') return verb;
  const { sub } = verb;
  const p = parseVerb(verb.rest, sub === 'init' ? { owner: { type: 'string' } }
    : sub === 'sprite' ? { weight: { type: 'string', multiple: true }, variant: { type: 'string', multiple: true }, manifest: { type: 'string' } }
    : sub === 'icons' ? { name: { type: 'string' } }
    : {}, HOUSEHOLD_USAGE, io);
  if (typeof p === 'number') return p;
  const rest = p.positionals;
  const many = (k: string) => (p.values[k] as string[] | undefined) ?? [];
  if ((sub === 'show' || sub === 'commons') && rest.length) { io.stderr(HOUSEHOLD_USAGE); return 2; }
  try {
    if (sub === 'show') {
      const h = need(io);
      if (!h) return 1;
      io.stdout(`home     ${h.home}\nagents   ${h.agents.join(', ')}\ndefault  ${h.default}\n${h.owner ? `owner    ${h.owner}\n` : ''}`);
      return 0;
    }
    if (sub === 'init') {
      const agent = rest[0];
      if (!agent || rest.length !== 1) { io.stderr(HOUSEHOLD_USAGE); return 2; }
      const h = initHousehold(householdHome(io.env), agent, { owner: str(p.values.owner) });
      const cards = splitPeopleIntoCommons(h, agent, agentDir(h, agent));
      io.stdout(`Household at ${h.home}: ${agent} moved to agents/${agent}; ${h.home}/${agent} is now a symlink to it. ${cards} person card${cards === 1 ? '' : 's'} split into the commons directory.\n`);
      return 0;
    }
    if (sub === 'commons') {
      const h = need(io);
      if (!h) return 1;
      const moved = moveKnowledgeToCommons(h, h.default);
      io.stdout(moved ? `Knowledge moved to ${moved}; every agent shares it now.\n` : `agents/${h.default} has no knowledge.db to move.\n`);
      // Every agent's cards, so the daemon's "haven't been split" refusal can
      // always be cleared here.
      for (const a of h.agents) {
        const cards = splitPeopleIntoCommons(h, a, agentDir(h, a));
        io.stdout(`${a}: ${cards} person card${cards === 1 ? '' : 's'} split (handles and facts in the commons directory, the rest as ${a}'s relationships).\n`);
      }
      return 0;
    }
    if (sub === 'add') {
      const h = need(io);
      if (!h) return 1;
      const agent = rest[0];
      if (!agent || rest.length !== 1) { io.stderr(HOUSEHOLD_USAGE); return 2; }
      const next = addAgent(h, agent);
      io.stdout(`Agents: ${next.agents.join(', ')}\n`);
      return 0;
    }
    if (sub === 'sprite') {
      const h = need(io);
      if (!h) return 1;
      const weights = Object.fromEntries(many('weight').map((w) => { const [k, n] = w.split('='); return [k, Number(n)]; }));
      const variants = Object.fromEntries(many('variant').map((v) => { const at = v.lastIndexOf('='); const [state, weight, rare] = v.slice(at + 1).split(':'); return [v.slice(0, at), { state, weight: Number(weight), rare: rare === 'rare' }]; }));
      const [agent, ...files] = rest;
      const manifest = str(p.values.manifest);
      if (!agent || (manifest === undefined && files.length !== 2)) { io.stderr(HOUSEHOLD_USAGE); return 2; }
      const read = (f: string) => { try { return JSON.parse(readFileSync(f, 'utf-8')) as unknown; } catch { throw new HouseholdError(`${f} isn't JSON`); } };
      if (manifest === undefined) setSprite(h, agent, manifestFromPixelLab(read(files[1]), { weights, variants }), { 'sheet.png': readFileSync(files[0]) });
      else setSprite(h, agent, checkSpriteManifest(read(manifest)), Object.fromEntries(files.map((f) => [basename(f), readFileSync(f)])));
      io.stdout(`${agent}: a pixel face, facing ${spriteOf(h, agent)?.facings.join(', ')}.\n`);
      return 0;
    }
    if (sub === 'icons') {
      const h = need(io);
      if (!h) return 1;
      const [verb, ...args] = rest;
      if (verb === 'install' && args[0] && args.length === 1) {
        const r = installIconSet(h, args[0], str(p.values.name));
        io.stdout(`Icon set ${r.set}: ${r.apps.length} icons (${r.apps.join(', ')}), in use.\n`
          + (r.line.length ? `Line-only, inverted on a dark key: ${r.line.join(', ')}.\n` : ''));
        return 0;
      }
      if (verb === 'set' && args[0] && args[1] && args.length === 2) {
        const r = setIcon(h, args[0], readFileSync(args[1]));
        io.stdout(`${args[0]}: a new icon in ${r.set}${r.line ? ' (line-only)' : ''}.\n`);
        return 0;
      }
      if (verb === 'use' && args[0] && args.length === 1) {
        useIconSet(h, args[0] === 'none' ? null : args[0]);
        io.stdout(args[0] === 'none' ? 'No icon set in use.\n' : `Icon set ${args[0]} in use.\n`);
        return 0;
      }
      if (verb === 'list' && args.length === 0) {
        const using = iconSetName(h);
        const sets = installedIconSets(h);
        io.stdout(sets.length ? sets.map((s) => `${s}${s === using ? ` (in use: ${Object.keys(iconSetOf(h)?.apps ?? {}).length} icons)` : ''}\n`).join('') : 'No icon sets installed.\n');
        return 0;
      }
      io.stderr(HOUSEHOLD_USAGE);
      return 2;
    }
    io.stderr(HOUSEHOLD_USAGE);
    return 2;
  } catch (err) {
    if (err instanceof HouseholdError) { io.stderr(`${err.message}\n`); return 1; }
    throw err;
  }
}

/** The owner token behind every session a sign-in link opens. */

const TOKEN_OPTIONS: Record<string, VerbOptions> = {
  create: {
    agent: { type: 'string' }, service: { type: 'string' }, house: { type: 'string' }, owner: { type: 'boolean' },
    peer: { type: 'string' }, piece: { type: 'string' }, runtime: { type: 'string' }, label: { type: 'string' },
  },
  list: {},
  revoke: {},
  link: { minutes: { type: 'string' }, 'page-url': { type: 'string' }, label: { type: 'string' } },
};

export async function runToken(argv: string[], io: IOStreams): Promise<number> {
  const verb = verbOf(argv, Object.keys(TOKEN_OPTIONS), TOKEN_USAGE, io);
  if (typeof verb === 'number') return verb;
  const { sub } = verb;
  // Every flag is parsed, and --help answered, before anything is minted or revoked.
  const p = parseVerb(verb.rest, TOKEN_OPTIONS[sub], TOKEN_USAGE, io);
  if (typeof p === 'number') return p;
  const rest = p.positionals;
  const v = (k: string) => str(p.values[k]);
  if (sub !== 'revoke' && rest.length) { io.stderr(`Unexpected argument: ${rest[0]}\n${TOKEN_USAGE}`); return 2; }
  try {
    if (sub === 'create') {
      const h = need(io);
      if (!h) return 1;
      const label = v('label');
      const service = v('service');
      const house = v('house');
      if ((service !== undefined || house !== undefined) && !v('agent')) { io.stderr(TOKEN_USAGE); return 2; }
      const picked = [v('agent') && `agent:${v('agent')}${service !== undefined ? `/${service}` : ''}${house !== undefined ? `@${house}` : ''}`, p.values.owner === true && 'owner', v('peer') && `peer:${v('peer')}`, v('piece') && `piece:${v('piece')}`, v('runtime') && `runtime:${v('runtime')}`].filter(Boolean) as string[];
      const role = picked.length === 1 ? parseRole(picked[0]) : null;
      if (!label || !role) { io.stderr(TOKEN_USAGE); return 2; }
      const { token, record } = createToken(h, { role, label, ...(role.kind === 'runtime' ? { runtimePieces: runtimePieces(io.env) } : {}) });
      // The token goes to stdout alone, so it can be piped straight into a file.
      io.stderr(`Created ${record.role} token "${record.label}". It won't be shown again.\n`);
      io.stdout(`${token}\n`);
      return 0;
    }
    if (sub === 'list') {
      const h = need(io);
      if (!h) return 1;
      const tokens = loadTokens(h.home);
      if (!tokens.length) { io.stdout('No tokens yet.\n'); return 0; }
      for (const t of tokens) {
        const state = t.revoked ? 'revoked' : expired(t) ? 'expired' : 'live   ';
        io.stdout(`${state}  ${t.role.padEnd(16)}  ${t.label}  (created ${t.created.slice(0, 10)}${t.last_used ? `, last used ${t.last_used.slice(0, 16).replace('T', ' ')}` : ', never used'}${t.expires && !t.revoked ? `, expire${expired(t) ? 'd' : 's'} ${t.expires.slice(0, 16).replace('T', ' ')}` : ''}${t.revoked ? `, revoked ${t.revoked.slice(0, 10)}` : ''})\n`);
      }
      return 0;
    }
    if (sub === 'link') {
      const h = need(io);
      if (!h) return 1;
      const minutes = Number(v('minutes') ?? 10);
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > 24 * 60) { io.stderr('--minutes is 1 to 1440\n'); return 2; }
      const code = signinLink(h, minutes * 60, undefined, v('label'));
      const base = (v('page-url') ?? io.env.LOOM_PUBLIC_URL ?? io.env.LOOM_BOX_PUBLIC_URL ?? '').replace(/\/+$/, '');
      io.stderr(`One sign-in, within ${minutes} minute${minutes === 1 ? '' : 's'}.${base ? '' : ' (Prefix loom\'s address: pass --page-url or set LOOM_PUBLIC_URL.)'}\n`);
      io.stdout(`${base}/login/${code}\n`);
      return 0;
    }
    if (sub === 'revoke') {
      const h = need(io);
      if (!h) return 1;
      const label = rest.join(' ').trim();
      if (!label) { io.stderr(TOKEN_USAGE); return 2; }
      const t = revokeToken(h, label);
      io.stdout(`Revoked ${t.role} token "${t.label}".\n`);
      return 0;
    }
    io.stderr(TOKEN_USAGE);
    return 2;
  } catch (err) {
    if (err instanceof HouseholdError) { io.stderr(`${err.message}\n`); return 1; }
    throw err;
  }
}

const SESSIONS_USAGE = `Usage: loom sessions <command>

  list                     Every browser session on file: its ref, what it is, the label its sign-in
                           link had, how it signed in, when it signed in and was last used (UTC), its
                           token, and "(ended)" for one past its 30 days or whose token is revoked
  revoke <ref>             Sign that one browser out at once (and stop its notifications); every
                           other session, its token's too, stays signed in

A script that signed in for screenshots ends its own session with POST /logout from the same
browser before it closes; \`loom sessions revoke\` is for one that didn't.
`;

/** \`loom sessions\` (t-1871): the page's browser sessions, each ended alone. Local only, like \`loom token\`. */
export async function runSessions(argv: string[], io: IOStreams): Promise<number> {
  try {
    return sessionsCommand(argv, io);
  } catch (err) {
    if (err instanceof HouseholdError) { io.stderr(`${err.message}\n`); return 1; }
    // Another loom process holding ui-sessions.json's lock past its wait: say so, and try again later.
    if (err instanceof Error && err.message === 'ui sessions are locked') { io.stderr('The sessions file is busy; try again in a moment.\n'); return 1; }
    throw err;
  }
}

function sessionsCommand(argv: string[], io: IOStreams): number {
  const verb = verbOf(argv, ['list', 'revoke'], SESSIONS_USAGE, io);
  if (typeof verb === 'number') return verb;
  const { sub } = verb;
  const p = parseVerb(verb.rest, {}, SESSIONS_USAGE, io);
  if (typeof p === 'number') return p;
  const rest = p.positionals;
  if (sub === 'list' && rest.length) { io.stderr(SESSIONS_USAGE); return 2; }
  if (sub === 'list') {
    const h = need(io);
    if (!h) return 1;
    const tokens = loadTokens(h.home);
    const all = sessionStore(h.home).list();
    if (!all.length) { io.stdout('No browser is signed in.\n'); return 0; }
    const at = (s: number) => `${new Date(s * 1000).toISOString().slice(0, 16).replace('T', ' ')}`;
    const nowS = Math.floor(Date.now() / 1000);
    for (const x of all) {
      const t = tokens.find((k) => k.sha256 === x.secret.toString('hex'));
      const token = !t ? 'no token on file' : `${t.label}${t.revoked ? ' (revoked)' : expired(t) ? ' (expired)' : ''}`;
      // Ended: past its 30 days, or its token revoked or expired. A session with no token on file (the owner's bearer
      // from loom-http's environment, LOOM_BEARER_TOKEN) is as live as the page says it is.
      const ended = nowS - x.issuedAt > SESSION_MAX_AGE_S || (!!t && (!!t.revoked || expired(t)));
      io.stdout(`${x.ref}  ${(x.device ?? 'a browser').padEnd(24)}  ${x.label ? `"${x.label}"  ` : ''}${x.via ? `by ${x.via}, ` : ''}signed in ${at(x.issuedAt)}${x.seenAt ? `, last used ${at(x.seenAt)}` : ''} UTC  (${token})${ended ? '  (ended)' : ''}\n`);
    }
    return 0;
  }
  if (sub === 'revoke') {
    const h = need(io);
    if (!h) return 1;
    const ref = (rest[0] ?? '').trim();
    if (!REF.test(ref) || rest.length !== 1) { io.stderr(SESSIONS_USAGE); return 2; }
    if (!sessionStore(h.home).revoke(ref)) { io.stderr(`No session ${ref} (see loom sessions list).\n`); return 1; }
    io.stdout(`Signed out session ${ref}. Every other session stays signed in.\n`);
    return 0;
  }
  io.stderr(SESSIONS_USAGE);
  return 2;
}
