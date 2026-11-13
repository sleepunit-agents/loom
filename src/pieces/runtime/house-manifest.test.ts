import { describe, expect, it } from 'vitest';
import { inspectHouseBuild, parseHouseManifest } from './house-manifest.js';

const build = { context: 'house', containerfile: 'house/Containerfile' };
const parse = (fields: Record<string, unknown> = {}) => parseHouseManifest(JSON.stringify({ build, ...fields }));
describe('repository house manifest validation', () => {
  it('validates the whole manifest before object inspection and pins the snapshot across awaits', async () => {
    const commit = 'a'.repeat(40), reads: string[] = [];
    let text = JSON.stringify({ build, privileged: true });
    const snapshot = {
      commit,
      async text(at: string) { reads.push(at); snapshot.commit = 'b'.repeat(40); return text; },
      async object(at: string, path: string) { reads.push(at); return { id: 'c'.repeat(40), type: path === 'house' ? 'tree' as const : 'blob' as const }; },
    };
    await expect(inspectHouseBuild(snapshot, 'art')).rejects.toThrow();
    expect(reads).toEqual([commit]);
    reads.length = 0;
    snapshot.commit = commit;
    text = JSON.stringify({ build, services: { bridge: { command: ['node'] } } });
    const result = await inspectHouseBuild(snapshot, 'art');
    expect(result).toMatchObject({ commit, image: 'loom-house-art:cccccccccccccccccccc', house: { task: 'stdin' } });
    expect(reads).toEqual([commit, commit, commit]);
    reads.length = 0;
    await expect(inspectHouseBuild(snapshot, 'Bad')).rejects.toThrow();
    await expect(inspectHouseBuild(snapshot, 'art', '../x')).rejects.toThrow();
    expect(reads).toEqual([]);
  });
  it('normalizes task and service defaults without granting requested capabilities', () => {
    const h = parse({ command: ['claude', '-p'], task: 'env', nested: true,
      secrets: { token: { file: 'token' }, api: { env: 'API_KEY' } },
      env: { ART_REPO: 'https://example.test/art' }, harnesses: ['claude', 'codex'],
      mounts: { state: '/state', nested: '/var/lib/containers', mirror: '/garage/art.git' },
      ports: ['7401', '0.0.0.0:4747'], tailnets: { fleet: '/run/fleet.sock' },
      services: { bridge: { command: ['node', 'bridge.js'], harnesses: ['codex'] } }, attach: ['bash'] });
    expect(h).toMatchObject({ build, task: 'env', command: ['claude', '-p'], nested: true,
      logins: ['claude', 'codex'], ports: [{ ip: null, port: 7401 }, { ip: '0.0.0.0', port: 4747 }],
      services: { bridge: { task: null, command: ['node', 'bridge.js'], logins: ['codex'], nested: false } }, attach: ['bash'] });
    expect(parse()).toEqual({ build, task: 'stdin', command: null, secrets: {}, env: {}, mounts: {},
      logins: [], nested: false, hostname: null, ports: [], tailnets: {}, services: {}, attach: ['sh'] });
    expect(parse({ build: { ...build, watch: ['src', 'docs', 'src'] } }).build.watch).toEqual(['docs', 'src']);
  });
  it('ports the old rejection cases for build paths, env, mounts, ports and unknown keys', () => {
    for (const fields of [
      { mounts: { home: '/home/art' } }, { mounts: { state: '/run/secrets' } },
      { env: { LD_PRELOAD: '/x.so' } }, { privileged: true },
      ...['../Containerfile', '/Containerfile', './house', 'house//x', 'house/../x'].map(context => ({ build: { ...build, context } })),
      ...[['80'], ['70000'], ['1.2.3:7401'], ['999.0.0.1:7401'], [7401], ['7401', '7401'], 'x'].map(ports => ({ ports })),
    ]) expect(() => parse(fields)).toThrow();
  });
  it('rejects destination collisions, reserved variables and login env overrides in every run spec', () => {
    const badRuns = [
      { secrets: { a: { file: 'same' }, b: { file: 'same' } } },
      { secrets: { a: { env: 'API_KEY' }, b: { env: 'API_KEY' } } },
      { secrets: { a: { env: 'API_KEY' } }, env: { API_KEY: 'literal' } },
      { secrets: { a: { env: 'HOUSE_ID' } } }, { secrets: { a: { file: 'x', env: 'X' } } },
      { secrets: { a: { file: '../token' } } }, { env: { HOME: '/evil' } }, { env: { A: 'x\n' } },
      { harnesses: ['claude'], env: { CLAUDE_SECURESTORAGE_CONFIG_DIR: '/evil' } },
      { harnesses: ['codex'], secrets: { a: { env: 'LOOM_LOGIN_CODEX' } } },
      { harnesses: ['claude', 'claude'] }, { harnesses: ['unknown'] },
      { mounts: { state: '/same', mirror: '/same' } },
      { mounts: { state: '/same' }, tailnets: { fleet: '/same' } },
      { tailnets: { fleet: '/run/secrets/token' } }, { mounts: { state: '/a/../b' } },
      { ports: ['7401', '0.0.0.0:7401'] },
    ];
    for (const run of badRuns) {
      expect(() => parse(run), JSON.stringify(run)).toThrow();
      expect(() => parse({ services: { bridge: run } }), JSON.stringify(run)).toThrow();
    }
  });
  it('fails closed on malformed containers, unsupported service fields and bounded lists', () => {
    for (const text of ['null', '[]', 'true', '{', JSON.stringify({}), ' '.repeat(4 * 1024 * 1024 + 1)]) {
      expect(() => parseHouseManifest(text)).toThrow();
    }
    const many = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`n${i}`, {}]));
    for (const fields of [
      { command: null }, { command: [] }, { command: ['x'.repeat(401)] }, { command: Array(33).fill('x') },
      { attach: [] }, { attach: Array(17).fill('sh') }, { hostname: 'UPPER' }, { nested: 'true' },
      { task: 'file' }, { services: { bridge: { task: 'stdin' } } }, { services: { bridge: { build } } },
      { services: { 'Bad name': {} } }, { services: many(17) }, { build: { ...build, gpu: true } },
      { build: { ...build, watch: Array(65).fill('src') } },
      ...['secrets', 'env', 'mounts', 'tailnets', 'services'].flatMap(key => [null, [], 'x'].map(value => ({ [key]: value }))),
      { secrets: Object.fromEntries(Object.keys(many(33)).map(n => [n, { file: n }])) },
      { tailnets: Object.fromEntries(Object.keys(many(5)).map(n => [n, `/${n}`])) },
    ]) expect(() => parse(fields), JSON.stringify(fields)).toThrow();
    expect(parse({ services: many(16) }).services).toHaveProperty('n15');
  });
});
