// @vitest-environment node
/**
 * A piece's form, answered (web/src/form.tsx, web/src/drafts.ts): more ways to send it beside its submit (a task's
 * Yes and No over a box of words), and the words typed in it kept on this device until it's sent (Jonathan,
 * 2026-11-04: a task's ask answered on its page, with loom#479's guard: nothing typed is lost to a button).
 */
import { describe, expect, it } from 'vitest';
import { createElement as h } from '../../web/node_modules/react/index.js';
import { renderToStaticMarkup } from '../../web/node_modules/react-dom/server.node.js';
import Form, { unsent, wordFields } from '../../web/src/form';
import { EnvContext } from '../../web/src/blocks';
import { formDraftKey, keepWords, keptWords } from '../../web/src/drafts';
import { parsePage } from './vocab.js';

const store = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), m }; };
const ASK = {
  type: 'form', action: 'answer', submit: 'Send', hidden: { id: 't-1273' },
  submits: [{ label: 'Yes', fields: { answer: 'yes' }, tone: 'primary' }, { label: 'No', fields: { answer: 'no' } }],
  fields: [{ name: 'text', label: 'Or answer in your own words', kind: 'textarea' }],
};
const page = (b: unknown) => parsePage({ title: 'T', sections: [{ id: 's', blocks: [b] }] });

describe('a form\'s submits, as a piece writes them', () => {
  it('takes Yes and No beside the submit, each with its own fields and tone', () => {
    const p = page(ASK);
    expect(typeof p).not.toBe('string');
    expect((p as Exclude<typeof p, string>).sections[0].blocks[0]).toMatchObject({ type: 'form', submit: 'Send', submits: ASK.submits });
  });
  it('a form without them is as before', () => {
    const { submits: _, ...plain } = ASK;
    expect((page(plain) as Exclude<ReturnType<typeof page>, string>).sections[0].blocks[0]).not.toHaveProperty('submits');
  });
  it('refuses a submit with no label, a tone that isn\'t primary or danger, or more than three', () => {
    expect(page({ ...ASK, submits: [{ fields: { answer: 'yes' } }] })).toMatch(/form.submits label/);
    expect(page({ ...ASK, submits: [{ label: 'Yes', tone: 'loud' }] })).toMatch(/tone must be primary or danger/);
    expect(page({ ...ASK, submits: [1, 2, 3, 4].map((n) => ({ label: `${n}` })) })).toMatch(/form.submits/);
  });
});

describe('a form\'s words, kept until sent', () => {
  it('are kept by the page, the action and its hidden fields, read back, and dropped once blank', () => {
    const s = store();
    const key = formDraftKey('/p/tasks/task/t-1273', 'answer', { id: 't-1273' });
    expect(key).not.toBe(formDraftKey('/p/tasks/task/t-1274', 'answer', { id: 't-1274' }));
    keepWords(key, { text: 'Patrick has it, ask him.', other: '  ' }, s);
    expect(keptWords(key, s)).toEqual({ text: 'Patrick has it, ask him.' });
    keepWords(key, { text: '' }, s);
    expect(s.m.size).toBe(0);
  });
  it('what can\'t be read back is nothing, and storage that throws breaks nothing', () => {
    const s = store();
    s.setItem('loom.draft.k', 'not json');
    expect(keptWords('k', s)).toEqual({});
    const bad = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('full'); }, removeItem: () => { throw new Error('denied'); } };
    expect(() => keepWords('k', { text: 'x' }, bad)).not.toThrow();
    expect(keptWords('k', bad)).toEqual({});
  });
  it('only boxes of words are kept: never a secret or a one-line value', () => {
    const f = { ...ASK, fields: [...ASK.fields, { name: 'pw', label: 'Password', kind: 'secret' }, { name: 'n', label: 'Name', kind: 'text' }] } as never;
    expect(wordFields(f)).toEqual(['text']);
    expect(unsent(f, { text: '', pw: 'hunter2', n: 'x' })).toBe(false);
    expect(unsent(f, { text: 'Patrick has it.' })).toBe(true);
  });
});

describe('the form, drawn', () => {
  const draw = (form: unknown) => renderToStaticMarkup(h(EnvContext.Provider, { value: { send: async () => true } as never }, h(Form, { form: form as never })));
  it('Yes, then No, then Send: the extra ones skip the required check, and nothing is "Not sent yet" while the box is empty', () => {
    const html = draw(ASK);
    const [yes, no, send] = ['>Yes<', '>No<', '>Send<'].map((s) => html.indexOf(s));
    expect(yes).toBeGreaterThan(-1);
    expect(no).toBeGreaterThan(yes);
    expect(send).toBeGreaterThan(no);
    expect(html.match(/formNoValidate/gi)?.length).toBe(2);
    expect(html).not.toContain('Not sent yet');
  });
  it('a form without submits draws its one button, as before', () => {
    const { submits: _, ...plain } = ASK;
    const html = draw(plain);
    expect(html).toContain('>Send<');
    expect(html).not.toMatch(/formNoValidate/i);
  });
});
