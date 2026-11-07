// Record the auto-play demo to video.
//
//   npm run dev                                  (in another terminal; serves http://localhost:5173)
//   node scripts/record-demo.mjs                 -> demo/out/runners-demo.webm (+ .mp4 if ffmpeg is on PATH)
//
// Options: --url <url>  --timeout <seconds, default 300>  --headless
// Needs Playwright, which is not in package.json yet:
//   npm i -D playwright && npx playwright install chromium
//
// The page must log 'DEMO_DONE' to the console when the director's last beat fires.
// Headed by default: three.js needs the real GPU, and headless Chromium falls back to slow software WebGL.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'demo', 'out');
const rawDir = join(outDir, 'raw');
const webm = join(outDir, 'runners-demo.webm');
const mp4 = join(outDir, 'runners-demo.mp4');

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const url = arg('url', 'http://localhost:5173/?autoplay=1');
const timeoutSec = Number(arg('timeout', '300'));
const headless = args.includes('--headless');
const W = 1920, H = 1080;

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.error('Playwright is not installed. Run:\n  npm i -D playwright && npx playwright install chromium');
  process.exit(1);
}

// Fail fast if the dev server isn't up.
try {
  const r = await fetch(new URL('/', url));
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
} catch (e) {
  console.error(`Can't reach ${url} (${e.message}). Start the app first: npm run dev`);
  process.exit(1);
}

mkdirSync(rawDir, { recursive: true });
// Use the installed Chrome when available (the bundled Chromium can be blocked on locked-down Windows machines).
const channel = args.includes('--bundled') ? undefined : 'chrome';
const browser = await chromium.launch({
  headless,
  channel,
  args: [`--window-size=${W},${H}`, '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
});
const context = await browser.newContext({
  viewport: { width: W, height: H },
  deviceScaleFactor: 1,
  recordVideo: { dir: rawDir, size: { width: W, height: H } },
});
const page = await context.newPage();

let done = false;
const finished = new Promise((resolveDone) => {
  page.on('console', (msg) => {
    const text = msg.text();
    if (msg.type() === 'error') console.error(`[page] ${text}`);
    if (text.includes('DEMO_DONE')) { done = true; resolveDone(); }
  });
});
page.on('pageerror', (e) => console.error(`[page error] ${e.message}`));

console.log(`Recording ${url} at ${W}x${H} ${headless ? '(headless)' : '(headed)'}...`);
const started = Date.now();
await page.goto(url, { waitUntil: 'load' });
await Promise.race([finished, new Promise((r) => setTimeout(r, timeoutSec * 1000))]);
if (!done) console.warn(`No DEMO_DONE after ${timeoutSec}s; saving what was recorded.`);
await page.waitForTimeout(1500);                     // hold the last frame a moment

const video = page.video();
await context.close();                               // flushes the video file
const rawPath = video ? await video.path() : null;
await browser.close();

if (!rawPath || !existsSync(rawPath)) {
  console.error('No video was written.');
  process.exit(1);
}
rmSync(webm, { force: true });
renameSync(rawPath, webm);
rmSync(rawDir, { recursive: true, force: true });
console.log(`Saved ${webm} (${Math.round((Date.now() - started) / 1000)}s)`);

const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
if (!hasFfmpeg) {
  console.log('ffmpeg not on PATH; skipping the mp4.');
  process.exit(done ? 0 : 2);
}
const ff = spawnSync('ffmpeg', [
  '-y', '-i', webm,
  '-c:v', 'libx264', '-crf', '18', '-preset', 'slow', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
  '-an', mp4,
], { stdio: 'inherit' });
if (ff.status !== 0) {
  console.error('ffmpeg failed; the webm is still there.');
  process.exit(1);
}
console.log(`Saved ${mp4}`);
process.exit(done ? 0 : 2);
