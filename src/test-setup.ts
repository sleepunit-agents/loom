/**
 * Vitest global setup.
 *
 * Stubs the vendored embedding runtime with a deterministic in-process
 * encoder so the test suite doesn't download the BGE ONNX model on
 * CI. The real runtime is exercised in embedding-runtime.parity.test.ts
 * (opt-in, LOOM_TEST_REAL_EMBEDDINGS=1); tests here only need stable
 * vectors for sqlite-vec storage/recall plumbing.
 */
import { Server } from 'node:http';
import { vi } from 'vitest';

// A test's server never closes an idle keep-alive socket; its client does. Playwright's request client (a context's
// `request`, `route.fetch`) keeps the socket of a request, the sign-in at the top of a test say, and sends a later one
// on it; Node's server closes a socket idle 5 s (keepAliveTimeout), so a request sent as it closes reads ECONNRESET
// (a browser resends a request on a reused socket that reset; Playwright doesn't). On a loaded runner the client hears
// of the close late, and the window is wide: route.fetch and request.get failed this way in loom's merge queue
// (2026-11-07). 0 turns the timer off; server.close() still drops idle sockets, and a context's close drops its own.
const listen = Server.prototype.listen;
Server.prototype.listen = function (this: Server, ...args: unknown[]) {
  this.keepAliveTimeout = 0;
  return (listen as (...a: unknown[]) => Server).apply(this, args);
} as typeof listen;

const DIMENSIONS = 384;

function encode(text: string): number[] {
  const vec = new Array<number>(DIMENSIONS).fill(0);
  const lower = text.toLowerCase();
  for (let i = 0; i < lower.length; i++) {
    vec[lower.charCodeAt(i) % DIMENSIONS] += 1;
  }
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
  return vec.map((v) => v / norm);
}

class FakeFlagEmbedding {
  static init(_opts: unknown): Promise<FakeFlagEmbedding> {
    return Promise.resolve(new FakeFlagEmbedding());
  }

  async *embed(texts: string[], _batchSize?: number): AsyncGenerator<number[][]> {
    yield texts.map(encode);
  }

  async *passageEmbed(texts: string[], _batchSize?: number): AsyncGenerator<number[][]> {
    yield texts.map(encode);
  }

  async queryEmbed(query: string): Promise<number[]> {
    return encode(query);
  }
}

vi.mock('./backends/embedding-runtime.js', () => ({
  FlagEmbedding: FakeFlagEmbedding,
  EmbeddingModel: {
    AllMiniLML6V2: 'fast-all-MiniLM-L6-v2',
    BGEBaseEN: 'fast-bge-base-en',
    BGEBaseENV15: 'fast-bge-base-en-v1.5',
    BGESmallEN: 'fast-bge-small-en',
    BGESmallENV15: 'fast-bge-small-en-v1.5',
    BGESmallZH: 'fast-bge-small-zh-v1.5',
    MLE5Large: 'fast-multilingual-e5-large',
  },
}));
