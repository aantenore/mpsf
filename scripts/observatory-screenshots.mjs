#!/usr/bin/env node
// Regenerates the Change Observatory screenshots in docs/images/ from the
// sample shop served by the visual-QA preview server (`--demo`).
// Needs Playwright with Chromium, which is not a plugin dependency:
//   npm install --no-save playwright && npx playwright install chromium
//   node scripts/observatory-screenshots.mjs
// or set PLAYWRIGHT_MODULE to an installed playwright package path.
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = resolve(root, "docs/images");
const port = Number(process.env.OBSERVATORY_SCREENSHOT_PORT || 4179);
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright").catch(() => {
  console.error("Playwright is not installed. Run: npm install --no-save playwright && npx playwright install chromium");
  process.exit(1);
});

const server = spawn(process.execPath, [resolve(root, "test/helpers/change-observatory-preview-server.mjs"), "--demo", "--port", String(port)], { stdio: ["ignore", "pipe", "inherit"] });
await new Promise((ready) => server.stdout.once("data", ready));
const base = `http://127.0.0.1:${port}/`;
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});

async function open(view, { scheme = "light", width = 1440, height = 860 } = {}) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1.5, colorScheme: scheme, locale: "en-US", reducedMotion: "reduce" });
  await page.goto(base);
  await page.waitForSelector(".dash-hero");
  await page.waitForSelector(".now-panel:not([hidden])");
  if (view !== "overview") {
    await page.click(`.nav-item[data-view="${view}"]`);
    await page.waitForTimeout(400);
  }
  await page.mouse.move(0, height - 1);
  await page.evaluate(() => document.activeElement?.blur());
  return page;
}

try {
  let page = await open("overview");
  await page.click(".now-details > summary");
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${out}/observatory-overview.png` });
  await page.close();

  page = await open("overview", { height: 1000 });
  await page.click(".chat-details > summary");
  await page.locator(".chat-room", { hasText: "ST-109" }).click();
  await page.evaluate(() => document.activeElement?.blur());
  await page.locator(".now-panel").screenshot({ path: `${out}/observatory-now-chat.png` });
  await page.close();

  page = await open("map");
  await page.click('[data-action="map-zoom"][data-zoom="out"]');
  await page.click('[data-action="map-zoom"][data-zoom="out"]');
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${out}/observatory-map.png` });
  await page.close();

  page = await open("activity");
  await page.screenshot({ path: `${out}/observatory-timeline.png` });
  await page.close();

  page = await open("stories", { scheme: "dark" });
  await page.screenshot({ path: `${out}/observatory-stories-dark.png` });
  await page.close();
  console.log(`Screenshots written to ${out}`);
} finally {
  await browser.close();
  server.kill();
}
