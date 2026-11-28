/** What must hold of every brick, whichever bricks there are (docs/specs/boards.md, "Adding a brick"). This is the
 * one suite that looks at the whole catalogue (./bricks.ts) and the page's whole registry
 * (web/src/boards/bricks.tsx), and it names no brick: what belongs to one brick is pinned beside its definition
 * (./bricks/<name>.test.ts) and beside its page module (web/src/boards/bricks-<name>.test.tsx). */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { bricks, catalogue, recordKinds } from './bricks.js';
import { idShapes } from './bricks/kit.js';
import { bricks as drawn } from '../../../web/src/boards/bricks';

const names = bricks.map((b) => b.name);
const page = 'web/src/boards/';

/** Bricks whose page checks are in a suite shared with other bricks, not in a file of their own, and that suite.
 * Each was written before bricks had a suite each. A new brick is never added here: it gets
 * web/src/boards/bricks-<name>.test.tsx. An entry is removed when its checks move to a file of that name. */
const sharedPageSuite: Record<string, string> = {
  trend: 'bricks.test.tsx', // its forms and its chart; its counting is in trend.test.ts
  ticket: 'bricks.test.tsx', // its forms and commands; its edit and link forms are in bricks-ticket-edit.test.tsx
  comments: 'bricks.test.tsx',
  repository: 'bricks-drawn.test.tsx',
  question: 'bricks-drawn.test.tsx', // its volume and what else it shows are in bricks-question-more.test.tsx
  agents: 'bricks-agent.test.tsx',
};
/** Operations whose name is put together where they are registered, so it is not written as
 * `name: '…'`: the file that registers each, and the part of the name that is written there. */
const composedOperations: Record<string, [file: string, written: string]> = {
  'mind.knowledgeVerify': ['src/pieces/mind/actions.ts', "['knowledgeVerify',"],
  'mind.knowledgeRecheck': ['src/pieces/mind/actions.ts', "['knowledgeRecheck',"],
  'mind.knowledgeAnnotate': ['src/pieces/mind/actions.ts', "['mind.knowledgeAnnotate',"],
  'tempo.runNow': ['src/core/tempo/operations.ts', "for (const action of ['stop', 'start', 'runNow'] as const) operations.register(operation({ ...common,\n    name: `tempo.${action}`"],
  'tempo.stop': ['src/core/tempo/operations.ts', "for (const action of ['stop', 'start', 'runNow'] as const) operations.register(operation({ ...common,\n    name: `tempo.${action}`"],
  'tempo.start': ['src/core/tempo/operations.ts', "for (const action of ['stop', 'start', 'runNow'] as const) operations.register(operation({ ...common,\n    name: `tempo.${action}`"],
  'tempo.pause': ['src/core/tempo/operations.ts', "for (const action of ['pause', 'resume'] as const) operations.register(operation({ ...common,\n    name: `tempo.${action}`"],
  'tempo.resume': ['src/core/tempo/operations.ts', "for (const action of ['pause', 'resume'] as const) operations.register(operation({ ...common,\n    name: `tempo.${action}`"],
};

describe('the catalogue and the registry are the same bricks', () => {
  it('names each brick once, as lower-case words joined by hyphens', () => {
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(/^[a-z]+(-[a-z]+)*$/);
    expect(names.length).toBeGreaterThan(0);
  });
  it('draws every brick of the catalogue, and draws no brick the catalogue does not hold', () => {
    expect(Object.keys(drawn).sort()).toEqual([...names].sort());
  });
  it('gives every brick a rectangle for each form before its body has been fetched, so a board is laid out at once', () => {
    for (const name of names) {
      const view = drawn[name];
      // Every brick has the small forms. One the catalogue lets be big has a primary form to be big in.
      for (const form of ['side', 'compact', ...(bricks.find((b) => b.name === name)!.big ? ['primary' as const] : [])] as const) {
        const fit = view.fits[form];
        expect(fit, `${name} ${form}`).toBeDefined();
        expect(fit.min, `${name} ${form}`).toBeGreaterThan(0);
        expect(fit.min <= fit.ideal && fit.ideal <= fit.max, `${name} ${form}`).toBe(true);
        expect(fit.height, `${name} ${form}`).toBeGreaterThan(0);
      }
      expect(typeof view.title({}), name).toBe('string');
      expect(typeof view.sub({}), name).toBe('string');
      expect(view.title({}).length, name).toBeGreaterThan(0);
    }
  });
});

describe('every definition (check 20)', () => {
  it('has a schema in which every parameter that is not a reference has a default, and names only known kinds of record', () => {
    for (const b of bricks) {
      const entry = catalogue().find((c) => c.name === b.name)!;
      const required = (entry.params as { required?: string[] }).required ?? [];
      for (const name of required) expect(b.references, `${b.name}.${name}`).toHaveProperty(name);
      const properties = Object.keys((entry.params as { properties?: object }).properties ?? {});
      for (const [name, kind] of Object.entries(b.references)) {
        expect(properties, `${b.name}.${name}`).toContain(name);
        expect(recordKinds, `${b.name}.${name}`).toContain(kind);
      }
      if (b.linkKey) expect(b.references, b.name).toHaveProperty(b.linkKey);
      expect((entry.params as { additionalProperties?: boolean }).additionalProperties, b.name).toBe(false);
      expect(b.shows.length, b.name).toBeGreaterThan(0);
    }
  });
  it('lets no action\'s detail hold a sentence: every property of every detail is a fixed list or one of the kit\'s id shapes, and nothing else is taken', () => {
    for (const brick of catalogue()) for (const [action, detail] of Object.entries(brick.actions) as [string, { additionalProperties?: boolean; properties?: Record<string, { enum?: unknown[]; pattern?: string }> }][]) {
      expect(detail.additionalProperties, `${brick.name}.${action}`).toBe(false);
      for (const property of Object.values(detail.properties ?? {})) {
        if (property.enum) expect(property.enum, `${brick.name}.${action}`).toBeInstanceOf(Array);
        else expect(idShapes, `${brick.name}.${action}: ${JSON.stringify(property)}`).toContain(property.pattern);
      }
    }
  });
  it('holds every id shape a detail may take to no blank space, so an id-shaped detail cannot carry a sentence', () => {
    for (const shape of idShapes) expect(shape, shape).not.toMatch(/ |\\s/);
    for (const shape of idShapes) expect(new RegExp(shape).test('two words'), shape).toBe(false);
  });
  it('reports each action for an operation loom registers', () => {
    const sources = (function read(directory: string): string[] {
      return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const path = directory + '/' + entry.name;
        if (entry.isDirectory()) return path === 'src/core/boards' ? [] : read(path);
        return entry.name.endsWith('.ts') && !entry.name.includes('.test.') ? [readFileSync(path, 'utf8')] : [];
      });
    })('src');
    const registered = (operation: string) => {
      const composed = composedOperations[operation];
      if (composed) return readFileSync(composed[0], 'utf8').includes(composed[1]);
      return sources.some((text) => text.includes(`name: '${operation}'`) || text.includes(`name:'${operation}'`));
    };
    const operations = new Set(bricks.flatMap((b) => Object.values(b.actions).map((a) => a.operation)));
    for (const operation of operations) expect(registered(operation), operation).toBe(true);
    for (const operation of Object.keys(composedOperations)) expect(operations, 'a stale entry: ' + operation).toContain(operation);
  });
});

describe('every brick has one home on each side, and its own checks', () => {
  it('is defined in a file of its name beside a suite of its name, and every definition there is in the catalogue', () => {
    const files = readdirSync('src/core/boards/bricks').filter((file) => !file.includes('.test.') && file !== 'kit.ts').map((file) => file.replace(/\.ts$/, ''));
    expect(files.sort()).toEqual([...names].sort());
    for (const name of names) {
      expect(readFileSync(`src/core/boards/bricks/${name}.ts`, 'utf8'), name).toContain(`name: '${name}'`);
      expect(existsSync(`src/core/boards/bricks/${name}.test.ts`), name + ' has no suite beside its definition').toBe(true);
    }
  });
  it('is drawn by a module of its name, which the registry fetches and nothing imports outright', () => {
    const registry = readFileSync(page + 'bricks.tsx', 'utf8');
    for (const name of names) {
      expect(existsSync(`${page}bricks-${name}.tsx`), name).toBe(true);
      expect(registry, name).toContain(`import('./bricks-${name}')`);
    }
    // The registry and the page fetch a brick's module; they never import one, or it would ship in the first script.
    for (const file of ['bricks.tsx', 'main.tsx', 'brick-kit.tsx']) expect(readFileSync(page + file, 'utf8'), file).not.toMatch(/^import [^;]*from '\.\/bricks-/m);
  });
  it('has a page suite of its name, or is one of the few whose checks are in a named shared suite', () => {
    for (const name of names) {
      const own = existsSync(`${page}bricks-${name}.test.tsx`), shared = sharedPageSuite[name];
      expect(own || !!shared, `${name} has no page suite: add ${page}bricks-${name}.test.tsx`).toBe(true);
      expect(own && !!shared, `${name} has its own page suite now: take it off the list`).toBe(false);
      if (shared) expect(readFileSync(page + shared, 'utf8'), `${shared} does not draw ${name}`).toContain(`'${name}'`);
    }
    for (const name of Object.keys(sharedPageSuite)) expect(names, 'a stale entry: ' + name).toContain(name);
  });
  it('has its row in both of the spec\'s tables', () => {
    const spec = readFileSync('docs/specs/boards.md', 'utf8');
    for (const name of names) expect(spec.split('\n').filter((line) => line.startsWith(`| \`${name}\``)).length, name).toBeGreaterThanOrEqual(2);
  });
});
