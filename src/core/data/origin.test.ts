import type { IncomingMessage } from 'node:http';
import { expect, it } from 'vitest';
import { sameIncomingOrigin, sameRequestOrigin } from './origin.js';

const fetched = (url: string, headers: Record<string, string>) => new Request(url, { headers });
const incoming = (host: string, headers: Record<string, string>, encrypted = false) => ({ headers: { host, ...headers }, socket: { encrypted } }) as unknown as IncomingMessage;
/** The same browser request as each door sees it: a Fetch request, and Node's request at the socket upgrade. */
const both = (host: string, headers: Record<string, string>, publicOrigin?: string) => {
  const answers = [sameRequestOrigin(fetched(`http://${host}/graphql`, headers), publicOrigin), sameIncomingOrigin(incoming(host, headers), publicOrigin)];
  expect(answers[0]).toBe(answers[1]);
  return answers[0];
};

it('gives every door the same answer about a browser\'s origin', () => {
  expect(both('loom:3000', {})).toBe(true);
  expect(both('loom:3000', { origin: 'http://loom:3000' })).toBe(true);
  expect(both('loom:3000', { origin: 'http://loom:3000', 'sec-fetch-site': 'cross-site' })).toBe(false);
  expect(both('loom:3000', { 'sec-fetch-site': 'cross-site' })).toBe(false);
  expect(both('loom:3000', { origin: 'https://elsewhere.test' })).toBe(false);
  expect(both('loom:3000', { origin: 'null' })).toBe(false);
});
it('takes the public origin, and only it, for a request that came to the public host', () => {
  const publicOrigin = 'https://loom.example';
  expect(both('loom.example', { origin: publicOrigin }, publicOrigin)).toBe(true);
  // Behind the proxy the program sees plain HTTP, but no page of this program is served at that origin.
  expect(both('loom.example', { origin: 'http://loom.example' }, publicOrigin)).toBe(false);
  // A request that came to another address of this machine is judged by that address.
  expect(both('192.168.1.5:3000', { origin: 'http://192.168.1.5:3000' }, publicOrigin)).toBe(true);
  expect(both('192.168.1.5:3000', { origin: publicOrigin }, publicOrigin)).toBe(false);
});
it('reads the address a socket request came to from the connection, never from a forwarded header', () => {
  expect(sameIncomingOrigin(incoming('loom', { origin: 'https://loom' }, true))).toBe(true);
  expect(sameIncomingOrigin(incoming('loom', { origin: 'https://loom', 'x-forwarded-proto': 'https' }))).toBe(false);
});
