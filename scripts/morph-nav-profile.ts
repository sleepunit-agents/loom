/** Profile a server from nav-bench.ts --serve. For a morph-enabled comparison,
 * build BOTH revisions with Comms' data-motion="off" stopgap temporarily removed.
 * Never use the real household's token: --server-log is the disposable bench log. */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { chromium } from "playwright-core";
const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? undefined : process.argv[i + 1];
};
const log = arg("--server-log"),
  out = arg("--out");
if (!log || !out) throw Error("--server-log and --out required");
const match = readFileSync(log, "utf8").match(
  /(http:\/\/127\.0\.0\.1:\d+)\s+token:\s+(\S+)/,
);
if (!match) throw Error("no bench server");
const [, base, token] = match;
const chrome = [
  process.env.LOOM_TEST_CHROME,
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].find((x) => x && existsSync(x));
if (!chrome) throw Error("no Chrome");
const browser = await chromium.launch({
  executablePath: chrome,
  args: ["--no-sandbox"],
});
const results = [];
try {
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    reducedMotion: "reduce",
  });
  await ctx.addInitScript(() => {
    localStorage.setItem("loom-look", "neon");
    sessionStorage.setItem("loom-arrived", "1");
    sessionStorage.setItem("loom-booted", "1");
  });
  await ctx.request.post(base + "/login", { form: { token }, maxRedirects: 0 });
  const p = await ctx.newPage();
  const errors: string[] = [];
  p.on("pageerror", (e) => errors.push(e.message));
  await p.goto(base + "/comms");
  await p.locator(".comms-row__btn").first().waitFor();
  await p.waitForTimeout(800);
  const cdp = await ctx.newCDPSession(p);
  await cdp.send("Performance.enable");
  for (const n of [2, 3, 2]) {
    const title = await p.locator(".comms-row__title").nth(n).textContent();
    const before = Object.fromEntries(
      (await cdp.send("Performance.getMetrics")).metrics.map((x) => [
        x.name,
        x.value,
      ]),
    );
    await cdp.send("Profiler.enable");
    await cdp.send("Profiler.start");
    await cdp.send("Tracing.start", {
      categories: "devtools.timeline,blink.user_timing,toplevel",
      transferMode: "ReturnAsStream",
    });
    const start = performance.now();
    await p.locator(".comms-row__btn").nth(n).click();
    await p.waitForFunction(
      (title) =>
        [...document.querySelectorAll(".comms-thread__title")].some(
          (e) => e.textContent?.trim() === title?.trim(),
        ) && document.querySelectorAll(".comms-msg--agent").length >= 20,
      title,
    );
    await p.waitForTimeout(250);
    const elapsed = performance.now() - start;
    const profile = await cdp.send("Profiler.stop");
    const done = new Promise<any>((r) =>
      cdp.once("Tracing.tracingComplete", r),
    );
    await cdp.send("Tracing.end");
    const { stream } = await done;
    let trace = "";
    for (;;) {
      const c = await cdp.send("IO.read", { handle: stream });
      trace += c.data;
      if (c.eof) break;
    }
    await cdp.send("IO.close", { handle: stream });
    const after = Object.fromEntries(
      (await cdp.send("Performance.getMetrics")).metrics.map((x) => [
        x.name,
        x.value,
      ]),
    );
    const delta = (name: string) => after[name] - before[name];
    const paths = await p.locator(".comms-msgs [data-morph-body][d]").count();
    if (paths < 20) throw Error("Comms morph stopgap still active: " + paths);
    const i = results.length;
    writeFileSync(`${out}.${i}.trace.json`, trace);
    writeFileSync(`${out}.${i}.cpu.json`, JSON.stringify(profile));
    results.push({
      row: n,
      reopen: n === 2 && i === 2,
      elapsed,
      paths,
      style: delta("RecalcStyleCount"),
      layout: delta("LayoutCount"),
      styleMs: delta("RecalcStyleDuration") * 1000,
      layoutMs: delta("LayoutDuration") * 1000,
      scriptMs: delta("ScriptDuration") * 1000,
      taskMs: delta("TaskDuration") * 1000,
    });
    await p.goBack();
    await p.locator(".comms-row__btn").nth(3).waitFor();
    await p.waitForTimeout(250);
  }
  writeFileSync(out, JSON.stringify({ results, errors }, null, 2));
  console.table(results);
  if (errors.length) throw Error(errors.join("\n"));
} finally {
  await browser.close();
}
