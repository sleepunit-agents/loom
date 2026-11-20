import { describe, it, expect } from 'vitest';
import { DOING_KINDS, parseManifest, type Manifest } from './vocab.js';

const manifest = (extra: Record<string, unknown>) => parseManifest({ v: 2, agents: { art: { jobs: [
  { id: 'run-one', status: 'running', text: 'Running work', ...extra },
] } } });

describe('job kind normalization', () => {
  it('retains every supported discriminator and accepts older reports without one', () => {
    for (const kind of DOING_KINDS) {
      expect((manifest({ kind }) as Manifest).agents!.art.jobs![0].kind).toBe(kind);
    }
    expect((manifest({}) as Manifest).agents!.art.jobs![0]).not.toHaveProperty('kind');
  });
  it('rejects unknown and non-string kinds rather than silently losing their identity', () => {
    for (const kind of ['unknown', 7, null, {}]) expect(manifest({ kind })).toMatch(/job.kind must be one of/);
  });
});
