/** Failure-only phase evidence for CI stalls (t-2012). Never records headers,
 * bodies, cookies, query strings or token values. No request timeout/retry changes. */
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { onTestFailed, onTestFinished } from 'vitest';
import type { Page } from 'playwright-core';

export function requestTrace() {
  const started = performance.now();
  const cpu = process.cpuUsage();
  const utilization = performance.eventLoopUtilization();
  const delay = monitorEventLoopDelay({ resolution: 20 });
  delay.enable();
  const events: { ms: number; phase: string }[] = [];
  const mark = (phase: string) => {
    if (events.length < 80) events.push({ ms: Math.round(performance.now() - started), phase });
  };
  const path = (url: string) => {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) ? u.pathname.slice(0, 200) : '(non-HTTP resource)';
  };
  onTestFailed(() => {
    const used = process.cpuUsage(cpu);
    console.warn('CI request phases', JSON.stringify({ events,
      elapsedMs: Math.round(performance.now() - started),
      cpuMs: Math.round((used.user + used.system) / 1000),
      eventLoopUtilization: performance.eventLoopUtilization(utilization).utilization,
      eventLoopDelayMaxMs: Math.round(delay.max / 1e6) }));
  });
  onTestFinished(() => { delay.disable(); });
  return {
    mark,
    async fetch(url: string, init?: RequestInit) {
      const label = `${init?.method ?? 'GET'} ${path(url)}`;
      mark(`${label} start`);
      const response = await fetch(url, init);
      mark(`${label} headers ${response.status}`);
      return response;
    },
    page(page: Page) {
      page.on('request', (r) => mark(`${r.method()} ${path(r.url())} start`));
      page.on('response', (r) => mark(`${path(r.url())} headers ${r.status()}`));
      page.on('requestfailed', (r) => mark(`${path(r.url())} failed`));
      page.on('domcontentloaded', () => mark('DOMContentLoaded'));
      page.on('load', () => mark('load'));
    },
  };
}
