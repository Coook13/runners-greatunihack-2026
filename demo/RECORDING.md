# Recording the demo

The auto-play demo runs at `http://localhost:5173/?autoplay=1` and takes just under 3 minutes. Space pauses, Right arrow skips to the next beat, R resets.

## 60-second checklist before you record

- [ ] Wifi off (the demo cuts the network, and it must not depend on it).
- [ ] Demo seed locked (`DEMO_SEED` in `src/contracts/config.ts`) and rehearsed once on this seed.
- [ ] Browser zoom at 100% (Ctrl+0).
- [ ] Notifications off: Windows Focus / Do not disturb on, Slack, Discord and mail closed.
- [ ] Laptop plugged in, battery saver off, other heavy apps closed.
- [ ] Window at 1920x1080, nothing else on the screen.
- [ ] Ran the demo once and saw the Leak Finder fire before 1:30 (see `demo/claims-to-proof.md`, claim 11).

## Way 1: the script (no voice)

```
npm i -D playwright && npx playwright install chromium   # once
npm run dev                                              # terminal 1
node scripts/record-demo.mjs                             # terminal 2
```

Writes `demo/out/runners-demo.webm`, then `demo/out/runners-demo.mp4` (H.264, crf 18) if ffmpeg is on PATH. It waits for the page to log `DEMO_DONE`, or gives up after 300 s (`--timeout 400` to change, `--url` to point elsewhere). It runs a visible Chrome window because three.js needs the GPU; `--headless` works but renders slowly.

Playwright's own video is low bitrate. Fine for a Devpost upload; use OBS for anything shown on a big screen.

## Way 2: Windows Game Bar (quickest with voice)

1. Open the demo in Chrome, full screen (F11).
2. Press Win+Alt+R to start recording, then Space to start the demo.
3. Talk over it with `demo/script.md`. Win+Alt+M toggles the mic.
4. Press Win+Alt+R to stop. The file lands in Videos\Captures.

Game Bar records one app window only, and it won't record the desktop or File Explorer.

## Way 3: OBS Studio (best quality)

1. Add a Display Capture or Window Capture source for the Chrome window.
2. Settings, Output: Recording format mp4 (or mkv, then remux), encoder hardware (NVENC/QuickSync) or x264, rate control CQP or CRF around 18.
3. Settings, Video: base and output 1920x1080, 30 or 60 fps.
4. Add your mic under Audio Mixer and check the level while reading the first line.
5. Start Recording, press Space in the browser, read the script, Stop Recording.
