import { expect, it } from 'vitest';
import * as page from './page.js';

it('writes words as text, and lets no caller hand markup to the shell', () => {
  expect(page.pageText('<img src=x onerror=1> & "quoted" \'single\' </title><script>')).toBe('&#60;img src=x onerror=1&#62; &#38; &#34;quoted&#34; &#39;single&#39; &#60;/title&#62;&#60;script&#62;');
  expect(page.pageText('Sign in to loom')).toBe('Sign in to loom');
  // The shell takes markup for its body, so it is not exported: each page here writes its own, from no argument.
  expect(Object.keys(page).sort()).toEqual(['SIGNIN_PAGE_POLICY', 'pageText', 'signinLinkPage']);
  expect(page.signinLinkPage.length).toBe(0);
  expect(page.signinLinkPage()).toContain('<title>Sign in to loom</title>');
});
