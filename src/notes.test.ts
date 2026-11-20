import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expiresAt, LIFESPAN_DAYS, MAX_FILE_BYTES, noteFilesDir, Notes } from './notes.js';

const DAY = 86_400_000;

describe('notes', () => {
  let dir: string;
  let now: number;
  let n: Notes;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'loom-notes-'));
    now = Date.parse('2026-10-30T12:00:00Z');
    n = new Notes(dir, () => now);
  });
  afterEach(() => { n.close(); rmSync(dir, { recursive: true, force: true }); });

  it('returns verified attachment bytes by note and name, including empty and maximum-size files',()=>{
    n.write('files','attachments',{by:'art',lifespan:'short'});
    expect(n.fileContents('files','missing')).toBeNull();
    for(const bytes of [Buffer.alloc(0),Buffer.alloc(MAX_FILE_BYTES,0xfd)]){
      const file=n.attach('files','data.bin',bytes);
      const loaded=n.fileContents('files','data.bin');
      expect(loaded?.sha256).toBe(file.sha256);
      expect(loaded?.bytes.equals(bytes)).toBe(true);
    }
    writeFileSync(n.filePath('files','data.bin')!,Buffer.alloc(MAX_FILE_BYTES,0xfa));
    expect(()=>n.fileContents('files','data.bin')).toThrow(/manifest/);
  });

  it('a note is written whole, with a lifespan when new, and keeps its old text as revisions', () => {
    expect(() => n.write('planning/2026-10-30', 'x', { by: 'art' })).toThrow(/needs its lifespan/);
    const a = n.write('planning/2026-10-30', '# Plan', { lifespan: 'while', by: 'art' });
    expect(a).toMatchObject({ path: 'planning/2026-10-30', lifespan: 'while', pinned: false, files: 0, expires: '2026-12-29T12:00:00.000Z' });
    now += DAY;
    // A rewrite keeps the lifespan and moves the clock.
    const b = n.write('planning/2026-10-30', '# Plan, revised', { by: 'art' });
    expect(b.lifespan).toBe('while');
    expect(b.expires).toBe(new Date(now + LIFESPAN_DAYS.while * DAY).toISOString());
    expect(n.read('planning/2026-10-30')!.body).toBe('# Plan, revised');
    expect(n.list({ prefix: 'planning/' }).map((r) => r.path)).toEqual(['planning/2026-10-30']);
    expect(expiresAt('keep', a.updated)).toBeNull();
  });

  it('paths are a few plain segments: no dot segments, no climbing out', () => {
    for (const bad of ['../x', 'a/../b', '.hidden', 'a/.b', '/abs', 'a//b', '']) {
      expect(() => n.write(bad, 'x', { lifespan: 'short', by: 'art' }), bad).toThrow(/a note path/);
    }
  });

  it("a file is stored once by its bytes, and goes when no note's file names it", () => {
    n.write('making/session-1', 'frames', { lifespan: 'short', by: 'art' });
    n.write('making/session-2', 'same frame', { lifespan: 'short', by: 'art' });
    const src = join(dir, 'frame.png');
    writeFileSync(src, 'PNGBYTES');
    const f1 = n.attach('making/session-1', 'frame.png', src, { type: 'image/png' });
    n.attach('making/session-2', 'cover.png', src);
    expect(f1).toMatchObject({ name: 'frame.png', bytes: 8, type: 'image/png' });
    const blobs = () => readdirSync(noteFilesDir(dir)).flatMap((d) => readdirSync(join(noteFilesDir(dir), d)));
    expect(blobs()).toEqual([f1.sha256]);
    expect(readFileSync(n.filePath('making/session-1', 'frame.png')!, 'utf-8')).toBe('PNGBYTES');
    expect(() => n.attach('nope', 'x.png', src)).toThrow(/no note nope/);
    n.delete('making/session-1');
    expect(blobs()).toEqual([f1.sha256]);
    n.delete('making/session-2');
    expect(blobs()).toEqual([]);
  });

  it('stores the full binary attachment limit, an empty file, and rejects oversize replacement', () => {
    n.write('fixtures/upload', 'files', { lifespan: 'keep', by: 'art' });
    const content = Buffer.alloc(MAX_FILE_BYTES, 0xff);
    content[0] = 0;
    const file = n.attach('fixtures/upload', 'full.bin', content);
    expect(file).toMatchObject({bytes:content.length, sha256:createHash('sha256').update(content).digest('hex')});
    expect(n.attach('fixtures/upload', 'empty.bin', Buffer.alloc(0)).bytes).toBe(0);
    expect(()=>n.attach('fixtures/upload', 'full.bin', Buffer.alloc(MAX_FILE_BYTES+1))).toThrow(/at most/);
    expect(readFileSync(n.filePath('fixtures/upload', 'full.bin')!).equals(content)).toBe(true);
  });

  it('keeps committed attachment bytes when a surrounding receipt rolls back', () => {
    const path = 'fixtures/receipt', name = 'sample.bin';
    n.write(path, 'attachment', { lifespan:'short', by:'art' });
    const old = n.attach(path, name, Buffer.from('original'));
    now += LIFESPAN_DAYS.short * DAY;
    for (const change of [
      ()=>n.attach(path, name, Buffer.from('replacement')),
      ()=>n.delete(path),
      ()=>n.sweep([]),
    ]) {
      expect(()=>n.atomicWrite(()=>{
        change();
        const reader = new Notes(dir, () => now, {readonly:true});
        try {
          expect(reader.read(path)?.fileList).toEqual([old]);
          expect(readFileSync(reader.filePath(path, name)!, 'utf8')).toBe('original');
        } finally { reader.close(); }
        throw Error('receipt failed');
      })).toThrow('receipt failed');
      expect(n.read(path)?.fileList).toEqual([old]);
      expect(readFileSync(n.filePath(path, name)!, 'utf8')).toBe('original');
      const root = noteFilesDir(dir);
      expect(readdirSync(root).flatMap(shard=>readdirSync(join(root,shard)))).toEqual([old.sha256]);
    }
  });

  it('a sweep lets expired notes go, but keeps the ones a memory or page cites, the pinned, and keep', () => {
    n.write('decisions/2026-10-30-x', 'ruling', { lifespan: 'keep', by: 'art' });
    n.write('planning/2026-10-01', 'old plan', { lifespan: 'while', by: 'art' });
    n.write('r0210/run', 'stdout', { lifespan: 'short', by: 'art' });
    n.write('making/after-sunday', 'frames', { lifespan: 'short', by: 'art' });
    n.write('evals/old', 'scratch', { lifespan: 'short', by: 'art' });
    n.write('teardowns/thing', 'judgment', { lifespan: 'short', by: 'art' });
    n.pin('teardowns/thing', true);
    now += 15 * DAY;
    // Cited two ways (the old notes/ prefix with .md, a file inside the note); a folder named in passing cites nothing.
    const cited = ['notes/r0210/run.md', 'notes/making/after-sunday/frame-12.png', 'note:evals/'];
    const dry = n.sweep(cited, { dryRun: true });
    expect(dry).toEqual({ gone: ['evals/old'], keptCited: ['r0210/run', 'making/after-sunday'] });
    expect(n.read('evals/old')).not.toBeNull();
    // The plan isn't due yet (60 days); a short note nobody cites goes.
    expect(n.sweep(cited).gone).toEqual(['evals/old']);
    expect(n.read('evals/old')).toBeNull();
    now += 60 * DAY;
    expect(n.sweep([]).gone.sort()).toEqual(['making/after-sunday', 'planning/2026-10-01', 'r0210/run']);
    expect(n.list().map((r) => r.path).sort()).toEqual(['decisions/2026-10-30-x', 'teardowns/thing']);
  });
});
