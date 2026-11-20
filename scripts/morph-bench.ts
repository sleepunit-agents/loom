/** CDP style/layout profiles of actual React morph mounts. Run before/after with --out FILE. */
import { build } from "esbuild";
import { chromium } from "playwright-core";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
const outIndex = process.argv.indexOf("--out");
const out = outIndex < 0 ? undefined : process.argv[outIndex + 1];
const chrome = [
  process.env.LOOM_TEST_CHROME,
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].find((x) => x && existsSync(x));
if (!chrome) throw Error("no Chrome; set LOOM_TEST_CHROME");
const bundle = await build({
  entryPoints: ["scripts/fixtures/morph-mount.tsx"],
  nodePaths: [resolve("web/node_modules")],
  plugins: process.env.MORPH_SOURCE
    ? [
        {
          name: "baseline",
          setup(b) {
            b.onLoad({ filter: /cojeev-motion\/use-morph\.ts$/ }, () => ({
              contents: readFileSync(process.env.MORPH_SOURCE!, "utf8"),
              loader: "ts",
            }));
          },
        },
      ]
    : [],
  bundle: true,
  write: false,
  format: "iife",
  define: { "process.env.NODE_ENV": '"production"' },
  alias: { "@": resolve("web/src") },
  jsx: "automatic",
});
const browser = await chromium.launch({
  executablePath: chrome,
  args: ["--no-sandbox"],
});
const results = [];
try {
  for (const count of [10, 40, 80])
    for (let run = 0; run < 3; run++) {
      const page = await browser.newPage({ reducedMotion: "reduce" });
      await page.setContent(
        '<html data-motion="reduce"><style>body{background:white}.v-btn{position:relative;background:rgb(40,80,120);border-radius:12px;width:100px;height:40px;margin:2px}.v-morph-live{background:transparent}.v-morph{position:absolute}</style><div id="root"></div>',
      );
      await page.addScriptTag({ content: bundle.outputFiles[0].text });
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Performance.enable");
      const before = (await cdp.send("Performance.getMetrics")).metrics;
      await cdp.send("Tracing.start", {
        categories: "devtools.timeline,blink.user_timing",
        transferMode: "ReturnAsStream",
      });
      const elapsed = await page.evaluate(async (count) => {
        const w = window as any;
        const start = performance.now();
        w.mountMorphs(count);
        await new Promise<void>((r) => queueMicrotask(r));
        return performance.now() - start;
      }, count);
      const finished = new Promise<any>((r) =>
        cdp.once("Tracing.tracingComplete", r),
      );
      await cdp.send("Tracing.end");
      const { stream } = await finished;
      let raw = "";
      for (;;) {
        const chunk = await cdp.send("IO.read", { handle: stream });
        raw += chunk.data;
        if (chunk.eof) break;
      }
      await cdp.send("IO.close", { handle: stream });
      const after = (await cdp.send("Performance.getMetrics")).metrics;
      const delta = (name: string) =>
        after.find((x) => x.name === name)!.value -
        before.find((x) => x.name === name)!.value;
      const trace = JSON.parse(raw);
      const events = trace.traceEvents.filter(
        (e: any) =>
          ["UpdateLayoutTree", "Layout"].includes(e.name) && e.ph === "X",
      );
      results.push({
        count,
        run,
        elapsed,
        style: delta("RecalcStyleCount"),
        layout: delta("LayoutCount"),
        styleMs: delta("RecalcStyleDuration") * 1000,
        layoutMs: delta("LayoutDuration") * 1000,
        paths: await page.locator("[data-morph-body][d]").count(),
        events: events.map((e: any) => ({ name: e.name, dur: e.dur })),
      });
      await page.close();
    }
} finally {
  await browser.close();
}
console.table(results.map(({ events, ...r }) => r));
if (out && out !== "--out")
  writeFileSync(out, JSON.stringify(results, null, 2));
