# Story UI wiring for src/main.ts

Three views tell the pitch from PLAN section 1. The black box is what a crew sees in the vehicle, the glass box is what an auditor sees with the auditor key, and the before/after card opens and closes the demo. Each one appends itself to the root you pass and positions itself, so mount all three on the `#ui` element after `createUI`.

```ts
import { createBlackBoxView } from './ui/blackbox';
import { createAuditorButton, createGlassBoxView } from './ui/glassbox';
import { createBeforeAfter } from './ui/beforeAfter';
import { buildReport } from './ledger';
import { exposureScore } from './privacy/breach';

const uiRoot = document.getElementById('ui')!;
const blackBox = createBlackBoxView(uiRoot);
const glassBox = createGlassBoxView(uiRoot);
const beforeAfter = createBeforeAfter(uiRoot);
```

## 1. Inspector select opens the black box

Call it in the same place you call `ui.showInspect`, and again on every snapshot while a node is selected (it only redraws when something changed, so calling it every tick is fine).

```ts
let selected: string | null = null;
renderer.onSelect((id) => { selected = id; refreshSelected(lastSnap); });

function refreshSelected(snap: Snapshot) {
  const info = selected ? engine.inspect(selected) : null;
  ui.showInspect(info && { id: selected!, ...info });
  blackBox.show(info && {
    id: selected!, ...info,
    pos: snap.nodes.find((n) => n.id === selected)?.pos,   // optional, gives "in 6 min"
    t: snap.t,                                             // optional
  });
}
```

It reads the engine's last 15 log lines plus the breach dump and works out the NEXT line and one line per crate. If you want to script exact wording for a stage moment, pass `instructions: ['NEXT: meet moto-04 at Tula junction in 6 min, hand over crate 2', 'Crate 1: deliver to Bona health post. Contents: sealed']` and it uses those instead.

Place names come from `src/geo/hawassa.json` (nearest named village to a cell centre, so `C9-5` reads as "Bona health post"). If the world ends up with exact clinic names, pass them in: `createBlackBoxView(uiRoot, { names: { clinic: (cell) => worldClinicName(cell), node: (id) => id } })`. The glass box takes the same `names` option.

On a central-mode device the dump holds the full picture, so the same screen turns coral and says "Full manifest on board". That contrast is worth clicking in split mode.

## 2. Auditor button opens the glass box

```ts
createAuditorButton(uiRoot, async () => {
  const input = engine.ledgerInput();
  const report = await buildReport(input, lastSnap.nodes);
  await glassBox.open({
    report,
    receipts: input.receipts,
    boxes: sealedBoxes(engine),          // needed to decrypt manifests, see below
    auditorSealPriv: engine.auditorSealPriv(),
    signPubs: input.signPubs,            // gives the signature check marks
    packageId: lastFindingPkg,           // optional, opens straight on that box
  });
});
```

It picks a box (boxes with findings first), opens its auditor copy with the auditor key, shows the manifest and a vertical chain of custody with time, cell, place, measured kg and a signature check at every hand-off. The hop where weight dropped is red with "Weight dropped 1.2 kg while moto-04 held it".

The engine has no public way to hand over the sealed boxes yet. The clean fix is one method on the engine (WP1): `sealedBoxes(): SealedBox[] { return [...this.boxes.values()].map((b) => b.cb.box); }`. Until then this bridge works because `boxes` is only private at compile time:

```ts
const sealedBoxes = (e: EngineApi) =>
  [...((e as unknown as { boxes?: Map<string, { cb: { box: SealedBox } }> }).boxes?.values() ?? [])].map((b) => b.cb);
```

Without `boxes` the glass box still shows every chain from the signed receipts and says the manifest is not loaded.

When the glass box is open, a Leak Finder click can jump to that box: in `onFindingClick(f)` add `if (glassBox.isOpen()) glassBox.focus(f.packageId);`.

## 3. Demo start and end show before/after

Show it once after warmup, before the first scripted event, and again after NETWORK UP and the ledger merge. Both runs share the seed in split mode, so pass the mesh snapshot as Runners and the central one as Today. Breach the same carrier id on both engines for the exposure numbers.

```ts
function showBeforeAfter(mesh: Snapshot, central: Snapshot) {
  const id = 'moto-04';
  beforeAfter.show({
    today: central.metrics,
    runners: mesh.metrics,
    todayExposure: exposureScore(centralEngine.inspect(id)!.dump),
    runnersExposure: exposureScore(meshEngine.inspect(id)!.dump),
  });
}
```

Bind it to a demo key (B toggles: `beforeAfter.isShown() ? beforeAfter.hide() : showBeforeAfter(...)`). While it is up, calling `show` again each snapshot keeps the numbers live. "Losses pinned to a hand-off" is `leaksPinpointed` out of `skimmed + stolen + deliveredShort`.

## Layout

The black box floats at top 84 px, right 404 px, so it sits beside the WP6 right column without covering it. The glass box is a large centred overlay under the top bar. The before/after card covers the screen with a light scrim. The auditor button sits bottom left next to the metrics column. Positions shift for screens under 1280 px. Pass `{ inline: true }` to the black box if you would rather put it inside your own container.

## Not checked yet

I have not seen these rendered in a browser, because there is no dev page for them and main.ts is not mine to edit. Screenshot all three once they are wired.
