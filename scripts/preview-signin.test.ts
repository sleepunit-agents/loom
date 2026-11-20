import { afterEach, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { request, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
// @ts-expect-error plain JS, run by hand
import { previewServer } from './preview-signin.mjs';

const cleanup: (() => void)[] = [];
afterEach(() => { for (const done of cleanup.splice(0)) done(); });

/** A build directory with one page and one asset, beside a file that is not part of it. */
async function preview() {
  const home = mkdtempSync(join(tmpdir(), 'loom-preview-')), root = join(home, 'build', 'web');
  mkdirSync(join(root, 'assets'), { recursive: true });
  writeFileSync(join(root, 'next.html'), 'THE PAGE'); writeFileSync(join(root, 'assets', 'app.js'), 'THE APP');
  for (const outside of [join(home, 'package.json'), join(home, 'build', 'package.json')]) writeFileSync(outside, 'OUTSIDE THE BUILD');
  const server: Server = previewServer('out', root); await new Promise<void>(listening => server.listen(0, '127.0.0.1', listening));
  cleanup.push(() => { server.close(); server.closeAllConnections(); rmSync(home, { recursive: true, force: true }); });
  // The target goes on the wire exactly as written: no client tidies `..` away first.
  return (target: string) => new Promise<{ status: number; body: string }>((answered, failed) => {
    const asked = request({ host: '127.0.0.1', port: (server.address() as AddressInfo).port, path: target, agent: false }, res => {
      let body = ''; res.setEncoding('utf8').on('data', part => { body += part; }).on('end', () => answered({ status: res.statusCode!, body }));
    });
    asked.on('error', failed).end();
  });
}

it('serves the build and nothing outside it, and goes on answering after a target it cannot read', async () => {
  const get = await preview();
  expect(await get('/')).toEqual({ status: 200, body: 'THE PAGE' });
  expect(await get('/app/assets/app.js')).toEqual({ status: 200, body: 'THE APP' });
  for (const target of ['/../package.json', '/%2e%2e/package.json', '/app/..%2f..%2fpackage.json', '/app/../package.json', '/app/../../package.json', '/app/%2e%2e/package.json', '/app//etc/passwd']) {
    const answer = await get(target);
    expect([target, answer.status], target).toEqual([target, 404]); expect(answer.body, target).toBe('Not found');
  }
  expect((await get('//[')).status).toBe(400);
  expect(await get('/auth/session')).toEqual({ status: 200, body: '{"viewer":null,"csrf":""}' });
});

it('is run by hand only: no package script and no workflow names it, and it names no address but this machine\'s own', () => {
  const root = new URL('../', import.meta.url), text = (path: string) => readFileSync(new URL(path, root), 'utf8');
  const under = (dir: string): string[] => readdirSync(new URL(dir, root)).flatMap(name => statSync(new URL(dir + name, root)).isDirectory() ? under(dir + name + '/') : [dir + name]);
  for (const file of ['package.json', 'web/package.json', ...under('.github/')]) expect(text(file), file).not.toContain('preview-signin');
  expect(text('scripts/preview-signin.mjs').match(/\b\d{1,3}(\.\d{1,3}){3}\b/g)).toEqual(['127.0.0.1', '127.0.0.1']);
});
