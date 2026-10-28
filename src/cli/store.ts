/**
 * `loom store <piece> …`: a piece's own store in loom (docs/specs/piece-storage.md).
 * Local only: POST /cli doesn't run it (it isn't a remote verb), and a piece's
 * code elsewhere uses POST /api/loom/store/<piece>/<op>.
 *
 * Who's writing comes from the environment loom gives the piece's process:
 * LOOM_STORE_GRANT (signed by loom for one call: a household owner's page
 * action, or the agent the piece is serving), else LOOM_PIECE_NAME for the
 * piece's own processes (its services), which write its `piece` and `agent`
 * collections, never an owner's.
 */
import { readRecord } from './pieces-managed.js';
import { householdHome } from '../household.js';
import { PieceStore, readGrant, StoreError, type Grant } from '../stores.js';
import type { IOStreams } from './io.js';

const USAGE = `Usage: loom store <piece> get <collection> <key>
       loom store <piece> list <collection> [--prefix P] [--limit N]
       loom store <piece> put <collection> <key> [--if-rev N]     (the JSON document on stdin)
       loom store <piece> del <collection> <key> [--if-rev N]
       loom store <piece> history <collection> <key>
       loom store <piece> revert <collection> <key> <revision-id>

A piece's own store in loom: collections of JSON documents, each write a revision.
Writes come from the piece: loom gives its processes what they may write.
`;

async function readStdin(io: IOStreams): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of (io.stdin ?? process.stdin) as AsyncIterable<Buffer>) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks).toString('utf-8');
}

/** Who this process writes as, for this piece: a grant loom signed, or the piece's own process. */
export function writerFor(env: NodeJS.ProcessEnv, home: string, piece: string): Grant | null {
  const g = readGrant(home, env.LOOM_STORE_GRANT);
  if (g) return g.piece === piece ? g : null;
  return env.LOOM_PIECE_NAME === piece ? { piece, exp: Number.MAX_SAFE_INTEGER } : null;
}

export async function runStore(argv: string[], io: IOStreams): Promise<number> {
  const env: NodeJS.ProcessEnv = io.env ?? process.env;
  const flags = new Map<string, string>();
  const pos: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { io.stdout(USAGE); return 0; }
    if (a === '--prefix' || a === '--limit' || a === '--if-rev') { flags.set(a, argv[++i] ?? ''); continue; }
    pos.push(a);
  }
  const [piece, op, collection, key, extra] = pos;
  if (!piece || !op || !collection) { io.stderr(USAGE); return 2; }
  const home = householdHome(env);
  const rec = readRecord(env, piece);
  if (!rec) { io.stderr(`loom store: no managed piece named ${piece}\n`); return 3; }
  const decl = rec.loom.store ?? {};
  const ifRev = flags.has('--if-rev') ? Number(flags.get('--if-rev')) : undefined;
  if (ifRev !== undefined && (!Number.isInteger(ifRev) || ifRev < 0)) { io.stderr('loom store: --if-rev is a revision number\n'); return 2; }
  const st = new PieceStore(home, piece);
  try {
    const writer = () => {
      const g = writerFor(env, home, piece);
      if (!g) throw new StoreError(`only ${piece} writes its store: loom gives its processes the right to`, 403);
      return g;
    };
    const out = (v: unknown) => { io.stdout(JSON.stringify(v) + '\n'); return 0; };
    switch (op) {
      case 'get': {
        if (!key) { io.stderr(USAGE); return 2; }
        const d = st.get(collection, key);
        if (!d) { io.stderr(`loom store: no ${collection}/${key}\n`); return 3; }
        return out(d);
      }
      case 'list': return out(st.list(collection, { prefix: flags.get('--prefix'), limit: flags.has('--limit') ? Number(flags.get('--limit')) : undefined }));
      case 'put': {
        if (!key) { io.stderr(USAGE); return 2; }
        let doc: unknown;
        try { doc = JSON.parse(await readStdin(io)); } catch { io.stderr('loom store: the document on stdin isn\'t JSON\n'); return 2; }
        return out({ rev: st.put(collection, key, doc, writer(), decl, ifRev) });
      }
      case 'del': {
        if (!key) { io.stderr(USAGE); return 2; }
        return out({ deleted: st.del(collection, key, writer(), decl, ifRev) });
      }
      case 'history': {
        if (!key) { io.stderr(USAGE); return 2; }
        return out(st.history(collection, key));
      }
      case 'revert': {
        const id = Number(extra);
        if (!key || !Number.isInteger(id)) { io.stderr(USAGE); return 2; }
        return out({ rev: st.revert(collection, key, id, writer(), decl) });
      }
      default:
        io.stderr(USAGE);
        return 2;
    }
  } catch (e) {
    if (e instanceof StoreError) {
      io.stderr(`loom store: ${e.message}\n`);
      return e.status === 409 ? 4 : e.status === 403 ? 5 : 1;
    }
    throw e;
  } finally {
    st.close();
  }
}
