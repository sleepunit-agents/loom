/** Legacy household asset helper retained for icon fixture tests. Main CLI uses the shared API. */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import {
  addAgent, agentDir, moveKnowledgeToCommons, householdHome, HouseholdError, initHousehold, loadHousehold,
  checkSpriteManifest, manifestFromPixelLab, setSprite, spriteOf, type Household,
} from '../household.js';
import { iconSetName, iconSetOf, installedIconSets, installIconSet, setIcon, useIconSet } from '../icon-set.js';
import { splitPeopleIntoCommons } from '../backends/people-household.js';
import type { IOStreams } from './io.js';
import { extractGlobalFlags, parseVerb, type VerbOptions } from './args.js';

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

