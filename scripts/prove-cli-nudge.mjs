// Isolated built-artifact proof; no host stores, installed binary or credentials.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { domainOf, nudgedSince, withLog } from '../dist/collections/log.js';
const root = mkdtempSync(join(tmpdir(), 't2115-built-proof-'));
const home = join(root, 'loom'); const bin = join(root, 'bin'); mkdirSync(bin);
const built = resolve('dist/index.js');
writeFileSync(join(bin, 'loom'), `#!${process.execPath}\nprocess.argv[1] = ${JSON.stringify(built)}; import(${JSON.stringify('file://' + built)});\n`);
chmodSync(join(bin, 'loom'), 0o755);
const env = { ...process.env, LOOM_HOME: home, PATH: bin, LOOM_URL: '', LOOM_CONTEXT_DIR: '', LOOM_BODY_CONVERSATION: '', TASKSTORE_DB: join(root, 'tasks.db'), TASKSTORE_OWNER: 'jonathan' };
const marker = () => withLog(home, db => nudgedSince(db, 0))[0]?.nudged ?? 0;
withLog(home, db => domainOf(db, 'tasks/task', 'isolated-proof'));
assert.equal(marker(), 0);
const watermark = Date.now() - 1000;
withLog(home, db => db.prepare('UPDATE domains SET nudged=?').run(watermark));
const core = spawnSync(process.execPath, [built, 'collections', 'nudge', 'tasks/task'], { env, encoding: 'utf8', timeout: 5000 });
assert.equal(core.status, 0, core.stderr); assert(marker() > watermark);
console.log('Built core command: exit 0, actual isolated tasks/task marker advanced.');
withLog(home, db => db.prepare('UPDATE domains SET nudged=?').run(watermark));
const tasks = resolve(process.argv[2]);
function run(args) { const r = spawnSync(process.execPath, [tasks, ...args], { env, encoding: 'utf8', timeout: 5000 }); assert.equal(r.status, 0, r.stderr + r.stdout); return JSON.parse(r.stdout); }
const created = run(['create', 'Isolated public seam proof', '--spec-item-ref', 'proof']); assert(created.ok); assert(marker() > watermark);
const after = marker(); run(['show', created.id]); run(['create', 'Isolated public seam proof', '--spec-item-ref', 'proof']); assert.equal(marker(), after);
console.log('Built taskstore -> built core: committed create advanced marker; read and duplicate-create no-op left it unchanged.');
console.log(JSON.stringify({ root, core: built, tasks, marker: marker() }));
