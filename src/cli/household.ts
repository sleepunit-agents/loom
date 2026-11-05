/**
 * `loom household` and `loom token` (docs/specs/household.md). Local only:
 * neither is a remote verb, so they never run through /cli. They read and
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
import { signinLink } from '../ui/sessions.js';

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
  link [--minutes 10] [--page-url <loom's page address>]
                           A one-time link that signs a browser in to the page (no token to paste).
                           Its sessions are the owner token "page sign-in links": revoke that to end them

Roles: agent:<name> is MCP and the CLI as that agent; owner sees everything and
the page; peer:<name> reaches commons knowledge only; piece:<piece>/<subject> is
a piece's own credential (e.g. a box's), reaching only POST /api/<piece>/.
runtime:<piece> is the runtime piece's (the one managed piece whose loom block
says "role": "runtime"), reaching only its own POST /api/loom/ routes. A review
token (review:<piece>) isn't made here: the runtime mints one per run, through
POST /api/loom/review/token, and it expires in two hours.
`;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

function need(io: IOStreams): Household | null {
  const home = householdHome(io.env);
  const h = loadHousehold(home);
  if (!h) io.stderr(`No household at ${home} (no household.json). Make one with: loom household init <agent>\n`);
  return h;
}

export async function runHousehold(argv: string[], io: IOStreams): Promise<number> {
  const [sub, ...rest] = argv;
  try {
    if (sub === 'show') {
      const h = need(io);
      if (!h) return 1;
      io.stdout(`home     ${h.home}\nagents   ${h.agents.join(', ')}\ndefault  ${h.default}\n${h.owner ? `owner    ${h.owner}\n` : ''}`);
      return 0;
    }
    if (sub === 'init') {
      const agent = rest[0];
      if (!agent || agent.startsWith('-')) { io.stderr(HOUSEHOLD_USAGE); return 2; }
      const h = initHousehold(householdHome(io.env), agent, { owner: flag(rest, '--owner') });
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
      if (!agent) { io.stderr(HOUSEHOLD_USAGE); return 2; }
      const next = addAgent(h, agent);
      io.stdout(`Agents: ${next.agents.join(', ')}\n`);
      return 0;
    }
    if (sub === 'sprite') {
      const h = need(io);
      if (!h) return 1;
      const pairs = (name: string) => rest.flatMap((a, i) => (a === name && rest[i + 1] ? [rest[i + 1]] : []));
      const weights = Object.fromEntries(pairs('--weight').map((w) => { const [k, n] = w.split('='); return [k, Number(n)]; }));
      const variants = Object.fromEntries(pairs('--variant').map((v) => { const at = v.lastIndexOf('='); const [state, weight, rare] = v.slice(at + 1).split(':'); return [v.slice(0, at), { state, weight: Number(weight), rare: rare === 'rare' }]; }));
      const [agent, ...files] = rest.filter((a, i) => !['--weight', '--variant'].includes(a) && !['--weight', '--variant'].includes(rest[i - 1]));
      const at = files.indexOf('--manifest');
      if (!agent || (at === -1 && files.length !== 2) || (at !== -1 && !files[at + 1])) { io.stderr(HOUSEHOLD_USAGE); return 2; }
      const read = (f: string) => { try { return JSON.parse(readFileSync(f, 'utf-8')) as unknown; } catch { throw new HouseholdError(`${f} isn't JSON`); } };
      if (at === -1) setSprite(h, agent, manifestFromPixelLab(read(files[1]), { weights, variants }), { 'sheet.png': readFileSync(files[0]) });
      else {
        const pngs = files.filter((_, i) => i !== at && i !== at + 1);
        setSprite(h, agent, checkSpriteManifest(read(files[at + 1])), Object.fromEntries(pngs.map((f) => [basename(f), readFileSync(f)])));
      }
      io.stdout(`${agent}: a pixel face, facing ${spriteOf(h, agent)?.facings.join(', ')}.\n`);
      return 0;
    }
    if (sub === 'icons') {
      const h = need(io);
      if (!h) return 1;
      const [verb, ...args] = rest;
      if (verb === 'install' && args[0]) {
        const at = args.indexOf('--name');
        const r = installIconSet(h, args[0], at === -1 ? undefined : args[at + 1]);
        io.stdout(`Icon set ${r.set}: ${r.apps.length} icons (${r.apps.join(', ')}), in use.\n`
          + (r.line.length ? `Line-only, inverted on a dark key: ${r.line.join(', ')}.\n` : ''));
        return 0;
      }
      if (verb === 'set' && args[0] && args[1]) {
        const r = setIcon(h, args[0], readFileSync(args[1]));
        io.stdout(`${args[0]}: a new icon in ${r.set}${r.line ? ' (line-only)' : ''}.\n`);
        return 0;
      }
      if (verb === 'use' && args[0]) {
        useIconSet(h, args[0] === 'none' ? null : args[0]);
        io.stdout(args[0] === 'none' ? 'No icon set in use.\n' : `Icon set ${args[0]} in use.\n`);
        return 0;
      }
      if (verb === 'list') {
        const using = iconSetName(h);
        const sets = installedIconSets(h);
        io.stdout(sets.length ? sets.map((s) => `${s}${s === using ? ` (in use: ${Object.keys(iconSetOf(h)?.apps ?? {}).length} icons)` : ''}\n`).join('') : 'No icon sets installed.\n');
        return 0;
      }
      io.stderr(HOUSEHOLD_USAGE);
      return 2;
    }
    io.stderr(HOUSEHOLD_USAGE);
    return sub === undefined || sub === '--help' || sub === '-h' ? 0 : 2;
  } catch (err) {
    if (err instanceof HouseholdError) { io.stderr(`${err.message}\n`); return 1; }
    throw err;
  }
}

/** The owner token behind every session a sign-in link opens. */

export async function runToken(argv: string[], io: IOStreams): Promise<number> {
  const [sub, ...rest] = argv;
  try {
    if (sub === 'create') {
      const h = need(io);
      if (!h) return 1;
      const label = flag(rest, '--label');
      const service = flag(rest, '--service');
      const house = flag(rest, '--house');
      if ((service !== undefined || house !== undefined) && !flag(rest, '--agent')) { io.stderr(TOKEN_USAGE); return 2; }
      const picked = [flag(rest, '--agent') && `agent:${flag(rest, '--agent')}${service !== undefined ? `/${service}` : ''}${house !== undefined ? `@${house}` : ''}`, rest.includes('--owner') && 'owner', flag(rest, '--peer') && `peer:${flag(rest, '--peer')}`, flag(rest, '--piece') && `piece:${flag(rest, '--piece')}`, flag(rest, '--runtime') && `runtime:${flag(rest, '--runtime')}`].filter(Boolean) as string[];
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
      const minutes = Number(flag(rest, '--minutes') ?? 10);
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > 24 * 60) { io.stderr('--minutes is 1 to 1440\n'); return 2; }
      const code = signinLink(h, minutes * 60);
      const base = (flag(rest, '--page-url') ?? io.env.LOOM_PUBLIC_URL ?? io.env.LOOM_BOX_PUBLIC_URL ?? '').replace(/\/+$/, '');
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
    return sub === undefined || sub === '--help' || sub === '-h' ? 0 : 2;
  } catch (err) {
    if (err instanceof HouseholdError) { io.stderr(`${err.message}\n`); return 1; }
    throw err;
  }
}
