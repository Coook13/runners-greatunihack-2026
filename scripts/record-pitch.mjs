// Non-destructive capture of the built demo. Keeps raw video, screenshots and timing evidence.
// node scripts/record-pitch.mjs --out demo/out/pitch-YYYYMMDD-HHMMSS --url http://127.0.0.1:4173/?demo=1&capture=1&seed=7
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

const args = process.argv.slice(2);
const arg = (name, fallback) => args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : fallback;
const out = resolve(arg('out', `demo/out/pitch-${new Date().toISOString().replace(/[:.]/g, '-')}`));
const url = arg('url', 'http://127.0.0.1:4173/?demo=1&capture=1&seed=7');
mkdirSync(join(out, 'raw'), { recursive: true });
const metadata = { url, out, beats: [], captions: [], errors: [], shots: [], started: null, rawPath: null };
const persist = () => writeFileSync(join(out, 'capture.json'), JSON.stringify(metadata, null, 2));
const browser = await chromium.launch({ channel: 'chrome', headless: false,
  args: ['--window-size=1920,1080', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1,
  recordVideo: { dir: join(out, 'raw'), size: { width: 1920, height: 1080 } } });
const origin = Date.now();
const page = await context.newPage();
const seconds = () => (Date.now() - origin) / 1000;
let done;
const finished = new Promise(r => { done = r; });
let timeout;
const timeoutResult = new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('No DEMO_DONE after 260 seconds')), 260000); });
const shots = new Set(['map','clipboard','black-box','handoff','breach-today','breach-runners','network-down','outage','glass-box','scoreboard','title']);
const pending = [];
async function shot(id) {
  const state = await page.evaluate(() => {
    const visible = e => { const s = getComputedStyle(e); return s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity || 1) > 0.05 && e.getBoundingClientRect().height > 0; };
    return { caption: document.querySelector('.rn-demo-cap')?.textContent, heading: document.querySelector('.rn-demo-heading')?.textContent,
      text: [...document.querySelectorAll('.rn-line,.rn-card,.rn-demo-card,.sb-gb,.sb-bb')].filter(visible).map(e => e.textContent),
      sides: window.runners.sides().map(s => ({ mode: s.mode, t: s.last.t, network: s.last.cellNetworkUp, metrics: s.last.metrics,
        alerts: s.engine.ledgerInput().alerts.filter(a => ['weight-mismatch','short-delivery'].includes(a.kind)) })) };
  });
  const file = join(out, `${id}.png`);
  await page.screenshot({ path: file });
  metadata.shots.push({ id, seconds: seconds(), file, state });
  persist();
  console.log('SHOT', id, JSON.stringify(state));
}
await page.exposeFunction('__recordBeat', detail => {
  const beat = { ...detail, seconds: seconds() };
  metadata.beats.push(beat); persist(); console.log('BEAT', JSON.stringify(beat));
  if (shots.has(detail.id)) pending.push(new Promise(resolveShot => setTimeout(resolveShot, detail.id === 'handoff' ? 12000 : 2200)).then(() => shot(detail.id)).catch(e => console.error('SHOT ERROR', e.message)));
});
await page.exposeFunction('__recordCaption', text => {
  metadata.captions.push({ text, seconds: seconds() }); persist(); console.log('CAPTION', text);
});
page.on('console', msg => {
  if (msg.text().includes('DEMO_DONE')) { console.log('DEMO_DONE', seconds()); done(); }
  if (msg.type() === 'error' || msg.type() === 'warning') console.log('PAGE', msg.type(), msg.text());
});
page.on('pageerror', error => { metadata.errors.push({ type: 'pageerror', text: error.message, seconds: seconds() }); persist(); console.error(error); });
page.on('response', response => { if (response.status() >= 400 && !response.url().endsWith('favicon.ico')) { metadata.errors.push({ type: 'http', url: response.url(), status: response.status() }); persist(); } });
try {
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.director && window.runners?.sides().every(s => s.last), { timeout: 60000 });
  await page.waitForTimeout(5000);
  await page.evaluate(() => {
    window.addEventListener('runners:beat', event => window.__recordBeat(event.detail));
    let previous = '';
    setInterval(() => { const text = document.querySelector('.rn-demo-cap')?.textContent || ''; if (text && text !== previous) { previous = text; window.__recordCaption(text); } }, 150);
  });
  metadata.started = seconds(); persist();
  await page.evaluate(() => window.director.start());
  await Promise.race([finished, timeoutResult]);
  clearTimeout(timeout);
  await page.waitForTimeout(2500);
  await Promise.all(pending);
} finally {
  clearTimeout(timeout);
  metadata.stopped = seconds();
  const video = page.video();
  await context.close();
  metadata.rawPath = video ? await video.path() : null;
  await browser.close();
  persist();
  console.log('CAPTURE_FINISHED', JSON.stringify({ out, rawPath: metadata.rawPath, errors: metadata.errors }));
}
