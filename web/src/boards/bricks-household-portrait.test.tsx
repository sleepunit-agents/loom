/** The `household` brick's agent portrait (./bricks-household-portrait.tsx; docs/specs/boards.md, "The first bricks"):
 * two files chosen in the brick, refused before sending when the desktop's limits refuse them, sent straight to the
 * desktop's `household.setPortrait`, and the board told only which agent and whether it was uploaded or restored.
 * The data hook, `fetch` and `FileReader` are fakes; what is checked is what loom would receive, what is drawn, and
 * that no file's name, size or contents reaches the board, a read, a flag, the address or storage. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createElement as h } from 'react';
// @ts-expect-error Renderer does not ship declarations.
import { act, create } from 'react-test-renderer';

const feed = vi.hoisted(() => vi.fn());
vi.mock('../data/graphql', () => ({ useDataQuery: feed }));
import { brickView, loadBricks } from './bricks';
import { forgetTokenNotices } from './token-notices';
import { SPRITE_MAX_BYTES } from '../../../src/desk-sprite-layout';
import { DOOR_REQUEST_BYTES } from '../../../src/core/data/door-limit';
import { manifestFromPixelLab } from '../../../src/pixellab-manifest';
import type { Form } from './layout';

await loadBricks();
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Node = { type: string; props: Record<string, any>; children: (Node | string)[]; findAll(match: (node: Node) => boolean): Node[]; findAllByType(type: string): Node[] };
let tree: { root: Node; toJSON(): unknown; unmount(): void } | undefined;
const reported = vi.fn(), raised = vi.fn(), moved = vi.fn(), stored = vi.fn();
const requests: { url: string; body: any }[] = [];
/** loom's answer: a status and a body, or no reply at all. */
let reply: () => { status: number; body: unknown } | 'no reply';
const PIXELLAB = { spritesheet: { cell_size: { width: 32, height: 32 }, columns: 4, rows: [{ row: 0, type: 'animation', animation: 'idle', direction: 'south', frame_count: 4 }] } };
const SHEET_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7, 7]), SHEET_BASE64 = Buffer.from(SHEET_BYTES).toString('base64');
const FILE_NAME = 'fern-secret-sheet.png', JSON_NAME = 'fern-secret-animation.json';
const sheet = (over: { bytes?: Uint8Array; type?: string; name?: string } = {}) => new File([over.bytes ?? SHEET_BYTES], over.name ?? FILE_NAME, { type: over.type ?? 'image/png' });
const metadata = (over: { text?: string; type?: string; name?: string } = {}) => new File([over.text ?? JSON.stringify(PIXELLAB)], over.name ?? JSON_NAME, { type: over.type ?? 'application/json' });
const setupAgent = (id: string, spriteVersion: string | null = null) => ({ id, spriteVersion, about: '', markBg: '#000', markFg: '#fff', faceShape: 'pebble', faceEyes: 'dot', github: [], removedAt: null });
const setup = {
  defaultAgent: 'art',
  members: [{ id: 'sam', role: 'owner', fullOwner: true, agents: [] }],
  agents: [setupAgent('art'), setupAgent('fern', 'v3'), setupAgent('not a ref')],
  tokens: [], sessions: [],
};
/** A FileReader as the browser's: `readAsDataURL` answers `data:<type>;base64,<bytes>`. Node has none. */
class FakeReader {
  result: string | null = null; onload: (() => void) | null = null; onerror: (() => void) | null = null;
  readAsDataURL(file: File) { void file.arrayBuffer().then((buffer) => { this.result = `data:${file.type};base64,` + Buffer.from(buffer).toString('base64'); this.onload?.(); }); }
}
beforeEach(() => {
  feed.mockReset(); reported.mockReset(); raised.mockReset(); moved.mockReset(); stored.mockReset(); requests.length = 0; forgetTokenNotices();
  reply = () => ({ status: 200, body: { ok: true, value: { version: 'v9' } } });
  feed.mockImplementation((query: string, _v?: object, options?: { pause?: boolean }) => {
    if (options?.pause) return { status: 'loading' };
    if (query.includes('householdSetup')) return { status: 'live', data: { householdSetup: setup, boxes: [], boxAlertSettings: [] } };
    if (query.includes('programSetup')) return { status: 'live', data: { programSetup: { owner: 'sam', catalogue: { records: [], operations: [] }, tokens: [] } } };
    throw new Error('A read the household brick should not make: ' + query);
  });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: { body: string; method: string; credentials: string }) => {
    requests.push({ url, body: JSON.parse(init.body) });
    expect([init.method, init.credentials]).toEqual(['POST', 'same-origin']);
    const answer = reply();
    if (answer === 'no reply') throw new TypeError('Failed to fetch');
    return { ok: answer.status >= 200 && answer.status < 300, status: answer.status, json: async () => answer.body };
  }));
  vi.stubGlobal('FileReader', FakeReader);
  vi.stubGlobal('location', { href: 'https://loom.example.test/boards?board=b-1', search: '', hash: '' });
  vi.stubGlobal('history', { pushState: moved, replaceState: moved });
  for (const name of ['localStorage', 'sessionStorage']) vi.stubGlobal(name, { setItem: stored, getItem: () => null, removeItem() {}, clear() {}, key: () => null, length: 0 });
});
afterEach(async () => { await act(async () => tree?.unmount()); tree = undefined; vi.unstubAllGlobals(); });

const draw = (form: Form = 'primary') => act(async () => { tree?.unmount(); tree = create(h(brickView('household').Body, { params: {}, form, act: reported, raise: raised })); });
const said = (node: Node | string): string => (typeof node === 'string' ? node : node.children.map(said).join(''));
const shown = () => said(tree!.root);
const button = (words: string) => tree!.root.findAllByType('button').find((b) => !b.props['data-place'] && (said(b) === words || b.props['aria-label'] === words));
const press = (words: string) => act(async () => { await button(words)!.props.onClick(); });
const portraitForm = (agent: string) => tree!.root.findAll((n) => n.type === 'form' && n.props['aria-label'] === `Animated portrait for ${agent}`)[0];
const choose = (agent: string, label: string, file: File | null) => act(async () => { portraitForm(agent).findAll((n) => n.type === 'input' && n.props['aria-label'] === label)[0].props.onChange({ target: { files: file ? [file] : [] } }); });
const submit = (agent: string) => act(async () => { await portraitForm(agent).props.onSubmit({ preventDefault() {} }); });
/** Choose both files for an agent's opened portrait and send them. Reading a file takes a turn of the event loop. */
async function upload(agent: string, files: { sheet?: File | null; metadata?: File | null } = {}) {
  await choose(agent, 'PixelLab sprite sheet', files.sheet === undefined ? sheet() : files.sheet);
  await choose(agent, 'PixelLab animation JSON', files.metadata === undefined ? metadata() : files.metadata);
  await submit(agent);
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}
/** Nothing of a file anywhere but the one request: not told, not flagged, not read with, not stored or in the address. */
function nothingOfTheFiles() {
  const elsewhere = JSON.stringify([reported.mock.calls, raised.mock.calls, feed.mock.calls, moved.mock.calls, stored.mock.calls]);
  for (const words of [FILE_NAME, JSON_NAME, SHEET_BASE64, 'spritesheet', 'cell_size', String(SHEET_BYTES.length), 'image/png', 'fern-secret']) expect(elsewhere, words).not.toContain(words);
  for (const [action, detail] of reported.mock.calls) if (action === 'setPortrait') expect(Object.keys(detail).sort()).toEqual(['agent', 'outcome']);
}

it('offers Portrait on each agent row of the big form, and nowhere in the small ones', async () => {
  await draw();
  expect(button('Portrait for art')).toBeDefined();
  expect(button('Portrait for fern')).toBeDefined();
  // An agent whose id a board cannot hold is drawn, with no change the board could not be told of.
  expect(shown()).toContain('not a ref');
  expect(button('Portrait for not a ref')).toBeUndefined();
  expect(shown()).not.toContain('changed on the desktop');
  await press('Portrait for art');
  expect(button('Add portrait')).toBeDefined();
  expect(button('Use generated face')).toBeUndefined();
  expect(tree!.root.findAll((n) => n.type === 'input' && n.props.type === 'file').map((n) => [n.props['aria-label'], n.props.accept]))
    .toEqual([['PixelLab sprite sheet', 'image/png'], ['PixelLab animation JSON', '.json,application/json']]);
  await press('Portrait for fern');
  expect(button('Replace portrait')).toBeDefined();
  expect(button('Use generated face')).toBeDefined();
  for (const form of ['side', 'compact'] as const) {
    await draw(form);
    expect(tree!.root.findAll((n) => n.type === 'input' && n.props.type === 'file'), form).toEqual([]);
    expect(button('Portrait for art'), form).toBeUndefined();
  }
});

it('sends an accepted sheet and its JSON straight to household.setPortrait, as the desktop does, and tells the board only the agent and that it was uploaded', async () => {
  await draw();
  await press('Portrait for art');
  await upload('art');
  expect(requests).toHaveLength(1);
  const [{ url, body }] = requests;
  expect(url).toBe('/api/household/setPortrait');
  expect(body.input).toEqual({ agent: 'art', version: null, portrait: { layout: manifestFromPixelLab(PIXELLAB), png: SHEET_BASE64 } });
  expect(typeof body.id).toBe('string');
  expect(shown()).toContain('Animated portrait saved.');
  expect(reported.mock.calls).toEqual([['setPortrait', { agent: 'art', outcome: 'uploaded' }]]);
  nothingOfTheFiles();
  // A JSON chosen by its name alone, as a file chooser may give it no type, is taken too; so is a sheet at the limit.
  await press('Portrait for fern');
  await upload('fern', { sheet: sheet({ bytes: new Uint8Array(SPRITE_MAX_BYTES) }), metadata: metadata({ type: '', name: 'Fern.JSON' }) });
  expect(requests).toHaveLength(2);
  expect(requests[1].body.input).toMatchObject({ agent: 'fern', version: 'v3' });
  expect(reported.mock.calls.at(-1)).toEqual(['setPortrait', { agent: 'fern', outcome: 'uploaded' }]);
});

it('refuses before sending a file over the limit, of the wrong type, missing, or a JSON that is not a PixelLab sheet\'s', async () => {
  await draw();
  await press('Portrait for art');
  const cases: [{ sheet?: File | null; metadata?: File | null }, string][] = [
    [{ sheet: sheet({ type: 'image/jpeg', name: 'fern.jpg' }) }, 'Choose a PNG sheet up to 4 MB.'],
    [{ sheet: sheet({ bytes: new Uint8Array(SPRITE_MAX_BYTES + 1) }) }, 'Choose a PNG sheet up to 4 MB.'],
    [{ sheet: sheet({ bytes: new Uint8Array(0) }) }, 'Choose a PNG sheet up to 4 MB.'],
    [{ sheet: null }, 'Choose a PNG sheet up to 4 MB.'],
    [{ metadata: metadata({ type: 'text/plain', name: 'notes.txt' }) }, 'Choose PixelLab animation JSON up to 1 MB.'],
    [{ metadata: metadata({ text: ' '.repeat(DOOR_REQUEST_BYTES + 1) }) }, 'Choose PixelLab animation JSON up to 1 MB.'],
    [{ metadata: null }, 'Choose PixelLab animation JSON up to 1 MB.'],
    [{ metadata: metadata({ text: 'not json {' }) }, 'Choose the PixelLab animation JSON that came with this sheet.'],
    [{ metadata: metadata({ text: '{"frames":[]}' }) }, 'Choose the PixelLab animation JSON that came with this sheet.'],
  ];
  for (const [files, words] of cases) {
    await upload('art', files);
    expect(shown(), words).toContain(words);
  }
  expect(requests).toEqual([]);
  expect(reported).not.toHaveBeenCalled();
  nothingOfTheFiles();
});

it('restores the generated face by household.setPortrait with no portrait, and tells the board it was restored', async () => {
  await draw();
  await press('Portrait for fern');
  await press('Use generated face');
  expect(requests.map((r) => [r.url, r.body.input])).toEqual([['/api/household/setPortrait', { agent: 'fern', version: 'v3', portrait: null }]]);
  expect(shown()).toContain('Generated face restored.');
  expect(reported.mock.calls).toEqual([['setPortrait', { agent: 'fern', outcome: 'restored' }]]);
});

it('says what a refusal (a 4xx) means in the desktop\'s words, clears the files, offers no retry and tells the board nothing', async () => {
  await draw();
  await press('Portrait for art');
  for (const [status, words] of [[409, 'The portrait changed. Review the current face and choose the files again.'], [403, 'Sign in as a household owner to change a portrait.'],
    [401, 'Sign in as a household owner to change a portrait.'], [400, 'Choose a valid PNG sheet up to 16 megapixels and its matching PixelLab animation JSON.'],
    [413, 'Choose a valid PNG sheet up to 16 megapixels and its matching PixelLab animation JSON.']] as const) {
    reply = () => ({ status, body: { ok: false, error: { code: 'denied', message: 'refused' } } });
    await upload('art');
    expect(shown(), String(status)).toContain(words);
    expect(button('Retry portrait change'), String(status)).toBeUndefined();
  }
  expect(requests).toHaveLength(5);
  expect(reported).not.toHaveBeenCalled();
  nothingOfTheFiles();
});

it('keeps a failed request (no reply, a 5xx, an answer not loom\'s) and retries it with the same id, telling the board once it is done', async () => {
  await draw();
  await press('Portrait for art');
  reply = () => 'no reply';
  await upload('art');
  expect(shown()).toContain('Could not confirm the change. Retry to check or finish it.');
  expect(reported).not.toHaveBeenCalled();
  reply = () => ({ status: 502, body: { ok: false } });
  // Retry is the form's submit.
  expect(button('Retry portrait change')!.props.type).toBe('submit');
  await submit('art');
  expect(shown()).toContain('Could not confirm the change. Retry to check or finish it.');
  reply = () => ({ status: 200, body: 'not loom' });
  await submit('art');
  expect(button('Retry portrait change')).toBeDefined();
  expect(reported).not.toHaveBeenCalled();
  reply = () => ({ status: 200, body: { ok: true, value: { version: 'v9' } } });
  await submit('art');
  expect(new Set(requests.map((r) => r.body.id)).size).toBe(1);
  expect(requests.map((r) => r.body.input.portrait.png)).toEqual(Array(requests.length).fill(SHEET_BASE64));
  expect(shown()).toContain('Animated portrait saved.');
  expect(reported.mock.calls).toEqual([['setPortrait', { agent: 'art', outcome: 'uploaded' }]]);
  nothingOfTheFiles();
});
