import { beforeAll, afterAll, it, expect } from "vitest";
import { build } from "esbuild";
import { chromium, type Browser, type Page } from "playwright-core";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
const chrome = [
  process.env.LOOM_TEST_CHROME,
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].find((p) => p && existsSync(p));
let browser: Browser, bundle: string;
beforeAll(async () => {
  if (!chrome) return;
  bundle = (
    await build({
      entryPoints: ["scripts/fixtures/morph-mount.tsx"],
      nodePaths: [resolve("web/node_modules")],
      bundle: true,
      write: false,
      format: "iife",
      define: { "process.env.NODE_ENV": '"development"' },
      alias: { "@": resolve("web/src") },
      jsx: "automatic",
    })
  ).outputFiles[0].text;
  browser = await chromium.launch({
    executablePath: chrome,
    args: ["--no-sandbox"],
  });
}, 30000);
afterAll(async () => {
  await browser?.close();
});
async function fixture(fn: (page: Page) => Promise<void>) {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    await page.setContent(
      '<html data-motion="reduce"><style>body{background:white}.v-btn{position:relative;background:rgb(40,80,120);border-radius:12px;width:100px;height:40px}.v-btn[aria-pressed=true]{background:rgb(120,80,40)}.v-morph-live{background:transparent}.v-morph{position:absolute}</style><div id="root"></div>',
    );
    await page.addScriptTag({ content: bundle });
    await fn(page);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
}
const test = it.skipIf(!chrome);
test("mount cost stays bounded when eighty hosts appear, with all paths ready before paint", async () =>
  fixture(async (p) => {
    const cdp = await p.context().newCDPSession(p);
    await cdp.send("Performance.enable");
    const metric = async () =>
      Object.fromEntries(
        (await cdp.send("Performance.getMetrics")).metrics.map((x) => [
          x.name,
          x.value,
        ]),
      );
    const a = await metric();
    await p.evaluate(async () => {
      (window as any).mountMorphs(80);
      await new Promise<void>((r) => queueMicrotask(r));
      if (document.querySelectorAll("[data-morph-body][d]").length !== 80)
        throw Error("not ready before paint");
    });
    const b = await metric();
    expect(b.RecalcStyleCount - a.RecalcStyleCount).toBeLessThan(12);
    expect(b.LayoutCount - a.LayoutCount).toBeLessThan(6);
  }));
test("unmount before the queued flush and StrictMode remount leave one decoration and restore authored styles", async () =>
  fixture(async (p) => {
    await p.evaluate(() => {
      const w = window as any;
      w.mountMorphs(40);
      w.mountMorphs(0);
    });
    expect(await p.locator("svg.v-morph").count()).toBe(0);
    await p.evaluate(() => {
      (window as any).mountMorphs(8, { strict: true, authored: true });
    });
    await expect.poll(() => p.locator("[data-morph-body][d]").count()).toBe(8);
    const restored = await p.evaluate(() => {
      const el = document.querySelector<HTMLElement>(".v-btn")!;
      (window as any).mountMorphs(0);
      return {
        fill: el.style.getPropertyValue("--mfill"),
        transform: el.style.transform,
        transition: el.style.transitionProperty,
        auto: el.dataset.autoMorph,
        svg: el.querySelector("svg"),
        classes: el.className,
      };
    });
    expect(restored).toEqual({
      fill: "rgb(1, 2, 3)",
      transform: "translateX(2px)",
      transition: "background-color",
      auto: undefined,
      svg: null,
      classes: "v-btn",
    });
    expect(await p.locator(".v-morph-host,svg.v-morph").count()).toBe(0);
    await p.evaluate(() => {
      (window as any).mountMorphs(8);
    });
    await expect.poll(() => p.locator("[data-morph-body][d]").count()).toBe(8);
  }));
test("hidden hosts stay undecorated until shown; resize updates every SVG", async () =>
  fixture(async (p) => {
    await p.evaluate(() => {
      (window as any).mountMorphs(8, { hidden: true });
    });
    expect(await p.locator("svg.v-morph").count()).toBe(0);
    await p.evaluate(() =>
      document.querySelector("#root>div")!.removeAttribute("hidden"),
    );
    await expect.poll(() => p.locator("[data-morph-body][d]").count()).toBe(8);
    const before = await p
      .locator("svg.v-morph")
      .first()
      .getAttribute("viewBox");
    await p.evaluate(() => {
      document
        .querySelectorAll<HTMLElement>(".v-btn")
        .forEach((e) => (e.style.width = "160px"));
    });
    await expect
      .poll(() => p.locator("svg.v-morph").first().getAttribute("viewBox"))
      .not.toBe(before);
    expect(
      await p
        .locator("svg.v-morph")
        .evaluateAll(
          (els) => new Set(els.map((e) => e.getAttribute("viewBox"))).size,
        ),
    ).toBe(1);
  }));
test("reduced motion keeps geometry and colors still across deterministic frames and a preference change", async () =>
  fixture(async (p) => {
    await p.evaluate(() => {
      const w = window as any;
      w.seedMorph(7);
      w.mountMorphs(4, { explicit: true, colors: true });
    });
    await expect.poll(() => p.locator("[data-morph-body][d]").count()).toBe(4);
    const snapshot = () =>
      p
        .locator("[data-morph-body]")
        .evaluateAll((els) =>
          els.map((e) => [e.getAttribute("d"), e.getAttribute("fill")]),
        );
    await p.evaluate(() => {
      (window as any).morphClock(1000);
    });
    const a = await snapshot();
    await p.evaluate(() => {
      (window as any).morphClock(5000);
    });
    expect(await snapshot()).toEqual(a);
    expect(await p.locator("[data-morph-colors]").count()).toBe(0);
    await p.evaluate(() => {
      document.documentElement.dataset.motion = "full";
    });
    await expect.poll(() => p.locator("[data-morph-colors]").count()).toBe(4);
    await p.evaluate(() => {
      document.documentElement.dataset.motion = "reduce";
    });
    await expect.poll(() => p.locator("[data-morph-colors]").count()).toBe(0);
    await p.evaluate(() => {
      (window as any).morphClock(6000);
    });
    const b = await snapshot();
    await p.evaluate(() => {
      (window as any).morphClock(9000);
    });
    expect(await snapshot()).toEqual(b);
  }));
test("selection paint retunes and settings off removes automatic but preserves explicit bodies", async () =>
  fixture(async (p) => {
    await p.evaluate(() => {
      (window as any).mountMorphs(4);
    });
    await expect.poll(() => p.locator("[data-morph-body][d]").count()).toBe(4);
    await p
      .locator(".v-btn")
      .first()
      .evaluate((e) => e.setAttribute("aria-pressed", "true"));
    await expect
      .poll(() =>
        p
          .locator(".v-btn")
          .first()
          .evaluate((e: HTMLElement) => e.style.getPropertyValue("--mfill")),
      )
      .toBe("rgb(120, 80, 40)");
    await p.evaluate(() => {
      (window as any).setMotionMode("off");
    });
    await expect.poll(() => p.locator("svg.v-morph").count()).toBe(0);
    await p.evaluate(() => {
      (window as any).mountMorphs(4, { explicit: true });
    });
    await expect.poll(() => p.locator("[data-morph-body][d]").count()).toBe(4);
    await p.evaluate(() => {
      (window as any).disableMorph(document.getElementById("root"));
    });
    expect(await p.locator("svg.v-morph").count()).toBe(4);
  }));

test("press still deforms a moving host, and reduced motion restores its authored transform", async () =>
  fixture(async (p) => {
    await p.evaluate(() => {
      document.documentElement.dataset.motion = "full";
      const w = window as any;
      w.morphClock(1000);
      w.mountMorphs(1, { authored: true });
    });
    await expect.poll(() => p.locator("[data-morph-body][d]").count()).toBe(1);
    await p.locator(".v-btn").dispatchEvent("pointerdown");
    await p.evaluate(() => {
      const w = window as any;
      for (let t = 1016; t <= 1200; t += 16) w.morphClock(t);
    });
    expect(
      await p.locator(".v-btn").evaluate((e: HTMLElement) => e.style.transform),
    ).toContain("scale(");
    await p.evaluate(() => {
      document.documentElement.dataset.motion = "reduce";
    });
    await expect
      .poll(() =>
        p.locator(".v-btn").evaluate((e: HTMLElement) => e.style.transform),
      )
      .toBe("translateX(2px)");
  }));
