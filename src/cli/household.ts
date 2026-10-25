/**
 * `loom household` and `loom token` (docs/specs/household.md). Local only:
 * neither is a remote verb, so they never run through /cli. They read and
 * write $LOOM_HOME (default ~/.config/loom) directly.
 */
import {
  addAgent, agentDir, moveKnowledgeToCommons, createToken, householdHome, HouseholdError, initHousehold, loadHousehold, loadTokens,
  parseRole, revokeToken, type Household,
} from '../household.js';
import { splitPeopleIntoCommons } from '../backends/people-household.js';
import type { IOStreams } from './io.js';

const HOUSEHOLD_USAGE = `Usage: loom household <command>

  show                     The household at $LOOM_HOME: agents, the default, the owner
  init <agent> [--owner <name>]
                           Make $LOOM_HOME/<agent> (a context dir) the first agent of a new
                           household: it moves to agents/<agent>, and a symlink stays behind
  add <agent>              Add an agent whose directory already exists under agents/
  commons                  Move the default agent's knowledge.db to commons/knowledge.db and
                           split every agent's person cards (handles and facts to the commons
                           directory, the rest stays as its relationships). Once, with
                           every loom daemon on this household stopped

$LOOM_HOME defaults to ~/.config/loom.
`;

const TOKEN_USAGE = `Usage: loom token <command>

  create (--agent <name> | --owner | --peer <name> | --piece <piece>/<subject>) --label <text>
                           Mint a token. It's printed once; only its sha256 is kept
  list                     Every token: label, role, created, last used, revoked
  revoke <label>           Revoke the live token with that label (takes effect on the next request)

Roles: agent:<name> is MCP and the CLI as that agent; owner sees everything and
the page; peer:<name> reaches commons knowledge only; piece:<piece>/<subject> is
a piece's own credential (e.g. a box's), reaching only POST /api/<piece>/.
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
    io.stderr(HOUSEHOLD_USAGE);
    return sub === undefined || sub === '--help' || sub === '-h' ? 0 : 2;
  } catch (err) {
    if (err instanceof HouseholdError) { io.stderr(`${err.message}\n`); return 1; }
    throw err;
  }
}

export async function runToken(argv: string[], io: IOStreams): Promise<number> {
  const [sub, ...rest] = argv;
  try {
    if (sub === 'create') {
      const h = need(io);
      if (!h) return 1;
      const label = flag(rest, '--label');
      const picked = [flag(rest, '--agent') && `agent:${flag(rest, '--agent')}`, rest.includes('--owner') && 'owner', flag(rest, '--peer') && `peer:${flag(rest, '--peer')}`, flag(rest, '--piece') && `piece:${flag(rest, '--piece')}`].filter(Boolean) as string[];
      const role = picked.length === 1 ? parseRole(picked[0]) : null;
      if (!label || !role) { io.stderr(TOKEN_USAGE); return 2; }
      const { token, record } = createToken(h, { role, label });
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
        io.stdout(`${t.revoked ? 'revoked' : 'live   '}  ${t.role.padEnd(16)}  ${t.label}  (created ${t.created.slice(0, 10)}${t.last_used ? `, last used ${t.last_used.slice(0, 16).replace('T', ' ')}` : ', never used'}${t.revoked ? `, revoked ${t.revoked.slice(0, 10)}` : ''})\n`);
      }
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
