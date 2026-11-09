/**
 * A household for the agent desktop's tests (docs/specs/agent-desk.md): agents with names, a runtime whose manifest
 * says what each is on and when it wakes next, Comms threads with replies, and asks that need the owner. Real loom over
 * HTTP; the runtime is a fake piece whose manifest is a file the test writes.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { startHttpServer, type HttpServeHandle } from '../transport/http-server.js';
import { agentDir, createToken, loadHousehold, type Household } from '../household.js';
import { parseLoomBlock, runtimePieces } from '../cli/pieces-managed.js';
import { createConversationTables, recordTurn, writeDigest } from '../backends/conversations.js';
import { adapterCall, openThread, titleFromAgent, type Thread } from '../comms.js';
import { clearPieceCache } from './pieces.js';
import { stopCommsWatch } from './comms-live.js';
import { closeAllBackends } from '../backends/index.js';

const RUNTIME_BIN = `#!${process.execPath}
const fs = require('node:fs');
if (process.argv[2] === 'ui' && process.argv[3] === '--json') {
  const f = process.env.LOOM_HOME + '/runtime-manifest.json';
  console.log(fs.existsSync(f) ? fs.readFileSync(f, 'utf-8') : JSON.stringify({ v: 2, owners: 2, tab: { label: 'Boxes' }, asks: [] }));
  process.exit(0);
}
let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  if (process.argv[2] === 'api') return console.log(JSON.stringify({ status: 200, body: { exit: 0, stdout: '{}', stderr: '' } }));
  console.log(JSON.stringify({ conversation: 'cv-0123456789ab', seq: 1, body: 'started' }));
});
`;

export type AgentReport = { jobs?: import('./vocab.js').Job[]; doing?: { text: string; kind?: string; where?: string; conversation?: string; since?: string }[];
  readings?: { label: string; value: string; detail?: string; tone?: string }[]; state?: string; reason?: string };

export type DeskHome = {
  h: Household; base: string; tok: Record<string, string>;
  /** What the runtime says about each agent (its manifest's `agents`), and its tile's stat. */
  report: (agents: Record<string, AgentReport>, tile?: { stat?: string; tone?: string }) => void;
  /** Tell loom the runtime's manifest moved. */
  changed: () => Promise<void>;
  thread: (person: string, agent: string, text: string, title?: string) => Thread;
  reply: (t: Thread, text: string) => void;
  /** An ask that needs the owner, from a wake of the agent's. */
  ask: (agent: string, ask: string) => void;
  close: () => Promise<void>;
};

/** Agents by id, with the name on their IDENTITY.md's first line. */
export async function deskHome(agents: Record<string, string>, members: { person: string; agents: '*' | string[] }[] = [{ person: 'jonathan', agents: '*' }]): Promise<DeskHome> {
  clearPieceCache();
  const ids = Object.keys(agents);
  const home = mkdtempSync(join(tmpdir(), 'loom-agent-desk-'));
  for (const a of ids) {
    mkdirSync(join(home, 'agents', a), { recursive: true });
    writeFileSync(join(home, 'agents', a, 'IDENTITY.md'), `# ${agents[a]}\n`);
    const db = new BetterSqlite3(join(home, 'agents', a, 'memories.db'));
    createConversationTables(db);
    db.close();
  }
  writeFileSync(join(home, 'household.json'), JSON.stringify({ v: 1, agents: ids, default: ids[0], owner: members[0].person,
    members: members.map((m) => ({ person: m.person, role: 'owner', agents: m.agents })) }));
  const saved = { LOOM_HOME: process.env.LOOM_HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
  process.env.LOOM_HOME = home;
  process.env.XDG_CONFIG_HOME = join(home, 'xdg');
  const h = loadHousehold(home)!;
  const loom = parseLoomBlock({ role: 'runtime', delivery: ['loom-runtime', 'deliver', '--json'] }, 'runtime', ['loom-runtime']);
  if (typeof loom === 'string') throw new Error(loom);
  const dir = join(home, 'pieces', 'runtime');
  mkdirSync(join(dir, 'current'), { recursive: true });
  writeFileSync(join(dir, 'piece.json'), JSON.stringify({ v: 1, name: 'runtime', source: { repo: 'x/y', commit: 'a'.repeat(40) }, package: 'runtime', version: '1', installed: 'x',
    bins: ['loom-runtime'], loom: Object.assign({ settings: [], services: [] }, loom) }));
  writeFileSync(join(dir, 'current', 'cli'), RUNTIME_BIN);
  chmodSync(join(dir, 'current', 'cli'), 0o755);
  mkdirSync(join(home, 'pieces', 'bin'), { recursive: true });
  symlinkSync(join(dir, 'current', 'cli'), join(home, 'pieces', 'bin', 'loom-runtime'));
  const tok: Record<string, string> = {};
  for (const m of members) tok[m.person] = createToken(h, { role: { kind: 'owner', member: m.person }, label: m.person }).token;
  tok.runtime = createToken(h, { role: { kind: 'runtime', piece: 'runtime' }, label: 'runtime', runtimePieces: runtimePieces(process.env) }).token;
  const report: DeskHome['report'] = (a, tile) => writeFileSync(join(home, 'runtime-manifest.json'), JSON.stringify({ v: 2, owners: 2,
    tab: { label: 'Boxes' }, ...(tile ? { tile: { label: 'Boxes', value: tile.stat ?? '', ...(tile.tone ? { tone: tile.tone } : {}) } } : {}), asks: [],
    agents: Object.fromEntries(Object.entries(a).map(([k, r]) => [k, { readings: r.readings ?? [], ...(r.jobs ? { jobs: r.jobs } : {}), ...(r.doing ? { doing: r.doing } : {}), ...(r.state ? { state: r.state } : {}), ...(r.reason ? { reason: r.reason } : {}) }])) }));
  report({});
  const handle: HttpServeHandle = await startHttpServer({ contextDir: agentDir(h, ids[0]), host: '127.0.0.1', port: 0, household: h });
  const base = `http://127.0.0.1:${handle.port}`;
  let n = 0;
  const B = 'abcdefghijklmnopqrstuvwxyz234567';
  const id = () => { const k = n++; return `aaaaaaaaaaaaaa${B[Math.floor(k / 32) % 32]}${B[k % 32]}`; };
  let wakes = 0;
  return {
    h, base, tok, report,
    changed: async () => { await fetch(`${base}/api/loom/pieces/changed`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tok.runtime}` }, body: '{}' }); },
    thread: (person, agent, text, title) => {
      const o = openThread(h, process.env, h.members.find((m) => m.person === person)!, { agent, id: id(), text });
      recordTurn(agentDir(h, agent), agent, { venue: 'loom', place: o.thread.id, at: new Date().toISOString(), from: { kind: 'person', slug: person }, kind: 'message', label: 'New thread' } as never, 'runtime:runtime');
      if (title) titleFromAgent(h.home, agent, o.thread.conversation, title);
      return o.thread;
    },
    reply: (t, text) => { adapterCall(h, process.env, { op: 'post', place: t.id, agent: t.agent, text }); },
    ask: (agent, ask) => {
      const k = wakes++;
      const conv = recordTurn(agentDir(h, agent), agent, { venue: 'wake', place: `lane:desk-${k}`, label: `ask ${k}`, at: new Date().toISOString(), from: { kind: 'schedule' }, kind: 'wake' }, 'runtime:clock').conversation;
      writeDigest(agentDir(h, agent), { conversation: conv, run: `r${k}` }, { summary: 'Checked.', needs_owner: { ask, why: 'Because it matters.', if_yes: 'I do it.', if_no: 'I leave it.' } } as never);
    },
    close: async () => {
      stopCommsWatch();
      await handle.close();
      await closeAllBackends();
      clearPieceCache();
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
      rmSync(home, { recursive: true, force: true });
    },
  };
}
