/**
 * Dense ONNX embedding runtime — vendored from the `fastembed` npm package.
 *
 * Why this file exists rather than a dependency: `Anush008/fastembed-js` was
 * archived on GitHub (last push 2025-12-15, latest publish 2.1.0). It pins
 * `tar: ^6.2.0`, and the 6.x line carries twelve unpatched advisories
 * including one critical. There is no upstream release to wait for, and an
 * `overrides` bump to tar 7 is blocked by exactly one line in the package —
 * `import tar from "tar"`, which tar 7 (no default export) turns into a hard
 * SyntaxError at import time.
 *
 * So the ~200 lines loom actually used are inlined here, depending directly on
 * `onnxruntime-node`, `@anush008/tokenizers` and `tar@^7`. Dropped along the
 * way: `progress` (loom always passed showDownloadProgress: false) and
 * `@huggingface/hub` (only the unused sparse/SPLADE path needed it).
 *
 * BEHAVIOUR IS PRESERVED BIT-FOR-BIT ON PURPOSE. Every vector already stored
 * in a loom database came out of the upstream package; a "cleanup" that
 * changed rounding, pooling or the query prefix would silently make old and
 * new vectors incomparable. Two upstream quirks are therefore kept, each
 * marked below:
 *   1. Vectors stay Float32Array end to end (normalisation rounds to f32).
 *   2. queryEmbed prefixes "query: ", an E5 convention that BGE does not
 *      actually use. Changing it moves every query in the embedding space.
 * Parity against fastembed@2.1.0 is asserted in embedding-runtime.parity.test.ts.
 */
import { AddedToken, Tokenizer } from '@anush008/tokenizers';
import { createWriteStream, existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { get as httpsGet } from 'node:https';
import { extname, join } from 'node:path';
import * as ort from 'onnxruntime-node';
import * as tar from 'tar';

/** Dense models this runtime knows how to fetch and run. */
export const EmbeddingModel = {
  AllMiniLML6V2: 'fast-all-MiniLM-L6-v2',
  BGEBaseEN: 'fast-bge-base-en',
  BGEBaseENV15: 'fast-bge-base-en-v1.5',
  BGESmallEN: 'fast-bge-small-en',
  BGESmallENV15: 'fast-bge-small-en-v1.5',
  BGESmallZH: 'fast-bge-small-zh-v1.5',
  MLE5Large: 'fast-multilingual-e5-large',
} as const;

export type EmbeddingModelName = (typeof EmbeddingModel)[keyof typeof EmbeddingModel];

/**
 * Where model tarballs come from. The upstream default was a Qdrant-owned
 * GCS bucket; as of 2026-10-16 every object in it 403s (t-1262) and nobody
 * at Qdrant maintains it, so it isn't coming back. The replacement is a
 * GitHub Release asset in this repo (sleepunit-agents/loom, tag
 * models-fast-bge-small-en-v1.5-v1): the exact bytes this box had already
 * downloaded from the GCS bucket before it died, reuploaded rather than
 * re-exported, and confirmed bit-identical against the
 * embedding-runtime.parity.test.ts golden vectors before upload. That
 * matters: the public Hugging Face re-exports of this model are either
 * int8/fp16-quantized or built with a different ONNX optimizer pass, and
 * produce embeddings close to but not bit-identical with every vector
 * already stored in a loom database. Only fast-bge-small-en-v1.5 — the
 * model loom actually defaults to (src/backends/index.ts) — has a release
 * asset; other EmbeddingModel entries will fail download() with a clear
 * "set LOOM_MODEL_BASE_URL" error until someone needs one and mirrors it
 * the same way. The env override exists so a dead host is a config change,
 * not a release.
 */
const DEFAULT_MODEL_BASE_URL =
  'https://github.com/sleepunit-agents/loom/releases/download/models-fast-bge-small-en-v1.5-v1';

export interface FlagEmbeddingInit {
  model: EmbeddingModelName;
  cacheDir: string;
  /** Token cap per input. Clamped by the model's own tokenizer config. */
  maxLength?: number;
}

/**
 * Loaded dense embedder: a tokenizer plus an ONNX inference session.
 *
 * Named for the upstream class so the diff in fastembed.ts stays reviewable.
 */
export class FlagEmbedding {
  private constructor(
    private readonly tokenizer: Tokenizer,
    private readonly session: ort.InferenceSession,
    private readonly model: EmbeddingModelName,
  ) {}

  static async init({
    model,
    cacheDir,
    maxLength = 512,
  }: FlagEmbeddingInit): Promise<FlagEmbedding> {
    const modelDir = await retrieveModel(model, cacheDir);
    const tokenizer = loadTokenizer(modelDir, maxLength);

    // MiniLM and multilingual-e5 ship an unoptimised graph; the BGE family
    // ships an optimised one. Upstream picks by model, so we do too.
    const fileName =
      model === EmbeddingModel.MLE5Large || model === EmbeddingModel.AllMiniLML6V2
        ? 'model.onnx'
        : 'model_optimized.onnx';
    const modelPath = join(modelDir, fileName);
    if (!existsSync(modelPath)) {
      throw new Error(`Model file not found at ${modelPath}`);
    }

    const session = await ort.InferenceSession.create(modelPath, {
      executionProviders: ['cpu'],
      graphOptimizationLevel: 'all',
    });
    return new FlagEmbedding(tokenizer, session, model);
  }

  async *embed(texts: string[], batchSize = 256): AsyncGenerator<Float32Array[]> {
    for (let i = 0; i < texts.length; i += batchSize) {
      yield await this.runBatch(texts.slice(i, i + batchSize));
    }
  }

  /**
   * QUIRK PRESERVED: the "query: " prefix is the E5 instruction format. BGE
   * models want "Represent this sentence for searching relevant passages: "
   * instead. Upstream applied E5's prefix to every model and loom's stored
   * vectors were produced under that regime, so it stays until we decide to
   * re-embed. See t-424.
   */
  async queryEmbed(query: string): Promise<Float32Array> {
    const [vector] = await this.runBatch([`query: ${query}`]);
    if (!vector) {
      throw new Error('embedding runtime: queryEmbed produced no vector');
    }
    return vector;
  }

  private async runBatch(texts: string[]): Promise<Float32Array[]> {
    const encoded = await Promise.all(texts.map((text) => this.tokenizer.encode(text)));

    const ids: bigint[][] = [];
    const mask: bigint[][] = [];
    const typeIds: bigint[][] = [];
    for (const item of encoded) {
      ids.push(item.getIds().map(BigInt));
      mask.push(item.getAttentionMask().map(BigInt));
      typeIds.push(item.getTypeIds().map(BigInt));
    }

    // Padding is fixed-length, so every row in the batch has the same length.
    const width = ids[0]?.length ?? 0;
    const shape = [texts.length, width];
    const inputs: Record<string, ort.Tensor> = {
      input_ids: new ort.Tensor('int64', ids.flat(), shape),
      attention_mask: new ort.Tensor('int64', mask.flat(), shape),
      token_type_ids: new ort.Tensor('int64', typeIds.flat(), shape),
    };
    // multilingual-e5 has no token_type_ids input in its graph.
    if (this.model === EmbeddingModel.MLE5Large) {
      delete inputs.token_type_ids;
    }

    const output = await this.session.run(inputs);
    const hidden = output.last_hidden_state;
    if (!hidden) {
      throw new Error('embedding runtime: model produced no last_hidden_state output');
    }
    return cls(hidden.data as Float32Array, hidden.dims as number[]).map(normalize);
  }
}

/**
 * CLS pooling: take the first token's hidden state for each sequence.
 *
 * Mirrors qdrant/fastembed a335c88, which removed attention pooling. Slicing a
 * Float32Array yields a Float32Array — that is load-bearing, see file header.
 */
function cls(data: Float32Array, dims: number[]): Float32Array[] {
  const [batch = 0, , hiddenSize = 0] = dims;
  return Array.from({ length: batch }, (_unused, index) => {
    const start = index * dims[1]! * hiddenSize;
    return data.slice(start, start + hiddenSize);
  });
}

/** L2 normalisation. Stays in Float32Array so results round exactly as before. */
function normalize(v: Float32Array): Float32Array {
  let sum = 0;
  for (const val of v) sum += val * val;
  const norm = Math.sqrt(sum);
  return v.map((val) => val / Math.max(norm, 1e-12));
}

function loadTokenizer(modelDir: string, maxLength: number): Tokenizer {
  const config = readJson(modelDir, 'config.json');
  const tokenizerConfig = readJson(modelDir, 'tokenizer_config.json');
  const tokensMap = readJson(modelDir, 'special_tokens_map.json');

  const tokenizerPath = join(modelDir, 'tokenizer.json');
  if (!existsSync(tokenizerPath)) {
    throw new Error(`Tokenizer file not found at ${tokenizerPath}`);
  }
  const tokenizer = Tokenizer.fromFile(tokenizerPath);

  tokenizer.setTruncation(Math.min(maxLength, Number(tokenizerConfig['model_max_length'])));
  tokenizer.setPadding({
    maxLength: Math.min(maxLength, Number(tokenizerConfig['model_max_length'])),
    padId: config['pad_token_id'] as number,
    padToken: tokenizerConfig['pad_token'] as string,
  });

  for (const token of Object.values(tokensMap)) {
    if (typeof token === 'string') {
      tokenizer.addSpecialTokens([token]);
    } else if (isAddedTokenMap(token)) {
      tokenizer.addAddedTokens([
        new AddedToken(token['content'] as string, true, {
          singleWord: token['single_word'] as boolean,
          leftStrip: token['lstrip'] as boolean,
          rightStrip: token['rstrip'] as boolean,
          normalized: token['normalized'] as boolean,
        }),
      ]);
    }
  }
  return tokenizer;
}

function readJson(modelDir: string, fileName: string): Record<string, unknown> {
  const path = join(modelDir, fileName);
  if (!existsSync(path)) {
    throw new Error(`${fileName} not found at ${path}`);
  }
  return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
}

/**
 * QUIRK PRESERVED: upstream tests for a `token` key that special_tokens_map
 * files do not have (they use `content`), so object-valued entries were always
 * skipped. Every model loom ships uses plain-string entries, making the branch
 * dead either way — but tightening the check would change tokenization for
 * some other model, so it stays as it was.
 */
function isAddedTokenMap(token: unknown): token is Record<string, unknown> {
  return (
    typeof token === 'object' &&
    token !== null &&
    'token' in token &&
    'single_word' in token &&
    'rstrip' in token &&
    'lstrip' in token &&
    'normalized' in token
  );
}

async function retrieveModel(model: EmbeddingModelName, cacheDir: string): Promise<string> {
  if (!existsSync(cacheDir)) {
    mkdirSync(cacheDir, { recursive: true });
  }
  const modelDir = join(cacheDir, model);
  if (existsSync(modelDir)) return modelDir;

  const archive = join(cacheDir, `${model}.tar.gz`);
  await download(archive, model);
  try {
    await extract(archive, cacheDir);
  } finally {
    if (existsSync(archive)) unlinkSync(archive);
  }
  return modelDir;
}

async function extract(archive: string, cacheDir: string): Promise<void> {
  if (extname(archive) !== '.gz') {
    throw new Error(`Unsupported file extension: ${archive}`);
  }
  await tar.x({ file: archive, cwd: cacheDir });
}

function download(outputPath: string, model: EmbeddingModelName): Promise<void> {
  if (existsSync(outputPath)) return Promise.resolve();

  // The MiniLM archive is published under its sentence-transformers name even
  // though its directory inside the tarball is the fast-* one.
  const remoteName =
    model === EmbeddingModel.AllMiniLML6V2
      ? `sentence-transformers${model.substring(model.indexOf('-'))}`
      : model;
  const base = process.env.LOOM_MODEL_BASE_URL ?? DEFAULT_MODEL_BASE_URL;
  const url = `${base}/${remoteName}.tar.gz`;

  // GitHub Release assets (the new default host) 302 to a signed, short-lived
  // blob URL; the GCS bucket they replace never redirected, so this following
  // logic didn't previously exist.
  return fetchToFile(url, outputPath, 5);
}

function fetchToFile(url: string | URL, outputPath: string, redirectsLeft: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const fail = (err: Error): void => {
      // A partial archive on disk would be treated as a complete download on
      // the next run, so it must not survive a failure.
      if (existsSync(outputPath)) unlinkSync(outputPath);
      reject(err);
    };
    httpsGet(url, { headers: { 'User-Agent': 'loom' } }, (response) => {
      const { statusCode, headers } = response;
      if (statusCode && statusCode >= 300 && statusCode < 400 && headers.location) {
        response.resume();
        if (redirectsLeft <= 0) {
          fail(new Error(`Model download failed: too many redirects fetching ${url.toString()}`));
          return;
        }
        fetchToFile(new URL(headers.location, url), outputPath, redirectsLeft - 1).then(resolve, fail);
        return;
      }
      if (statusCode !== 200) {
        response.resume();
        fail(
          new Error(
            `Model download failed: ${url.toString()} returned HTTP ${statusCode}. ` +
              'Set LOOM_MODEL_BASE_URL to fetch models from a different host.',
          ),
        );
        return;
      }
      const file = createWriteStream(outputPath);
      file.on('error', fail);
      response.on('error', fail);
      response.pipe(file);
      file.on('finish', () => {
        file.close((err) => (err ? fail(err) : resolve()));
      });
    }).on('error', fail);
  });
}
