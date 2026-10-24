/**
 * Marker-aware file writer for `loom inject`. Reads the target file,
 * decides between create / append / replace / no-change, writes
 * atomically via tmp-file + rename.
 *
 * The managed region is bounded by two HTML comments:
 *   <!-- loom:start v1 harness=<key> -->
 *   <!-- loom:end -->
 * Only "loom:start" / "loom:end" literals are matched; the metadata
 * (v1, harness=...) is informational for humans and is allowed to
 * differ between on-disk markers and the new block.
 */
import { readFile, writeFile, rename, mkdir, stat, chmod } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

export type WriteAction = 'created' | 'appended' | 'updated' | 'no-change';

export interface WriteResult {
  action: WriteAction;
  path: string;
  bytesWritten: number;
}

export type PreviewAction = WriteAction;

export class MalformedMarkersError extends Error {
  constructor(public readonly path: string, public readonly reason: string) {
    super(
      `inject: malformed loom markers in ${path}: ${reason}; fix manually or delete markers and retry`,
    );
    this.name = 'MalformedMarkersError';
  }
}

const START_RE = /<!--\s*loom:start(\s[^>]*)?-->/g;
const END_RE = /<!--\s*loom:end\s*-->/g;

export interface MarkerBounds {
  startIdx: number;
  endTerminusIdx: number;
}

export function findMarkers(text: string, path: string): MarkerBounds | null {
  const starts = [...text.matchAll(START_RE)];
  const ends = [...text.matchAll(END_RE)];
  if (starts.length === 0 && ends.length === 0) return null;
  if (starts.length > 1) {
    throw new MalformedMarkersError(path, `${starts.length} start markers found, expected 1`);
  }
  if (ends.length > 1) {
    throw new MalformedMarkersError(path, `${ends.length} end markers found, expected 1`);
  }
  if (starts.length !== ends.length) {
    throw new MalformedMarkersError(
      path,
      `mismatched markers (start=${starts.length}, end=${ends.length})`,
    );
  }
  const s = starts[0];
  const e = ends[0];
  const startIdx = s.index!;
  const endBegin = e.index!;
  const endTerminusIdx = endBegin + e[0].length;
  if (endBegin < startIdx) {
    throw new MalformedMarkersError(path, 'end marker appears before start marker');
  }
  return { startIdx, endTerminusIdx };
}

export function normalizeLF(s: string): string {
  return s.replace(/\r\n/g, '\n');
}

function ensureTrailingNewline(s: string): string {
  return s.endsWith('\n') ? s : s + '\n';
}

async function readIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf-8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export async function atomicWrite(
  path: string,
  content: string,
  preserveModeFrom: string | null,
): Promise<number> {
  await mkdir(dirname(path), { recursive: true });
  // A fresh, random temp name opened exclusively ('wx'): a fixed name could be
  // a symlink someone left there, and writing through it would land anywhere.
  const tmp = `${path}.${randomBytes(6).toString('hex')}.loom.tmp`;
  const buf = Buffer.from(content, 'utf-8');
  await writeFile(tmp, buf, { flag: 'wx' });
  if (preserveModeFrom) {
    try {
      const s = await stat(preserveModeFrom);
      await chmod(tmp, s.mode & 0o777);
    } catch {
      /* preserveModeFrom vanished between read and stat; leave tmp at default mode */
    }
  }
  await rename(tmp, path);
  return buf.byteLength;
}

export function buildContent(
  existing: string | null,
  block: string,
  markers: MarkerBounds | null,
): { next: string; action: WriteAction } {
  const blockLF = ensureTrailingNewline(block);
  if (existing === null) {
    return { next: blockLF, action: 'created' };
  }
  const norm = normalizeLF(existing);
  if (markers === null) {
    const withGap = norm.endsWith('\n') ? norm : norm + '\n';
    const combined = ensureTrailingNewline(`${withGap}\n${blockLF}`);
    return { next: combined, action: 'appended' };
  }
  const before = norm.slice(0, markers.startIdx);
  const after = norm.slice(markers.endTerminusIdx);
  const afterTrimmed = after.startsWith('\n') ? after.slice(1) : after;
  const combined = ensureTrailingNewline(`${before}${blockLF.replace(/\n$/, '')}\n${afterTrimmed}`);
  if (combined === norm) {
    return { next: combined, action: 'no-change' };
  }
  return { next: combined, action: 'updated' };
}

export async function writeManagedBlock(
  path: string,
  block: string,
): Promise<WriteResult> {
  const existing = await readIfExists(path);
  const markers = existing !== null ? findMarkers(normalizeLF(existing), path) : null;
  const { next, action } = buildContent(existing, block, markers);
  if (action === 'no-change') {
    return { action, path, bytesWritten: 0 };
  }
  const bytesWritten = await atomicWrite(path, next, existing !== null ? path : null);
  return { action, path, bytesWritten };
}

export async function previewWrite(
  path: string,
  block: string,
): Promise<PreviewAction> {
  const existing = await readIfExists(path);
  const markers = existing !== null ? findMarkers(normalizeLF(existing), path) : null;
  return buildContent(existing, block, markers).action;
}
