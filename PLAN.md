# Runners: build plan

GreatUniHack 2026, Neptune North track. Brief: "Design a system where multiple agents keep working toward a shared goal, even when communication fails."

Read this whole file before writing any code. Section 6 is the frozen contract every agent codes against. Section 8 has the brief for each coding agent.

---

## 1. The idea in one paragraph

Life-saving therapeutic food for starving children (RUTF, the peanut paste that treats severe malnutrition) gets stolen and resold, mostly by people inside the supply chain who know what is in each box and where the stock sits. Runners is software that runs inside drones, motorbikes, clinic vans and boats in remote rural districts with little or no signal. It moves sealed boxes to clinics in relays. Nobody in the middle can tell what is inside, where the stores are or which children are enrolled. Every hand-off is signed and weighed, so when food goes missing the ledger shows the exact hand-off where it vanished. When the network drops, the agents keep routing on their own, and when it returns every box is accounted for.

**The change we are making (lead with this on stage):**
- **Today:** aid workers carry paper or spreadsheet manifests that say what is in every carton and where it is going. They track stock by hand, phone ahead, and losses show up weeks later in a stock count. A stolen clipboard or a hacked phone gives away everything.
- **With Runners:** every vehicle (drone, motorbike, van, boat) has a **black box**: the agent device. It knows exactly which sealed crate goes to which clinic and tells the crew only what to do next ("hand crate 2 to the motorbike at the Tula junction", "deliver crate 1 to Bona health post"). The crew never needs to know or record what is inside or who it is for.
- **Auditors get a glass box:** with the auditor key they can open every manifest and see every box's full chain of custody, weights at each hand-off, and exactly where anything went missing.
- **The demo shows both side by side on the real map of Hawassa, Ethiopia:** left is today's way (central dispatch, everyone sees everything), right is Runners.

Three secrets we protect:
1. What's inside: every box looks the same, so nobody can pick out the valuable ones.
2. Where the stock sits: store rooms, stock levels and hand-off points.
3. Which children are enrolled: names never leave the clinic. Requests carry counts only.

One promise we make:
> Every sachet either reaches a clinic or we can show you exactly which hand-off it disappeared at.

We do NOT claim "exactly once" delivery or "theft-proof". Two cut-off groups can both serve the same request, and a determined thief can still steal. We count duplicates and we name the hop where loss happened.

---

## 2. What judges will see (3-minute demo)

Numbers in brackets come from the live run. Never write them in advance.

| Time | What happens | Criterion it scores |
|---|---|---|
| 0:00 | Hook: "Life-saving food for starving children is being stolen and sold in markets, mostly by people inside the supply chain." | Presentation |
| 0:15 | 3D map of a fictional rural district: hills, a river, villages, dirt roads. Identical sealed boxes ride drones, motorbikes, vans and boats from stores to clinics. | Excitement, design |
| 0:35 | Click a motorbike. Inspector: "holding 2 sealed boxes, dest cell C12-7, size M, next hop van-02. Contents: sealed." Its decision log scrolls. | Independent decisions |
| 0:55 | Big button: NETWORK DOWN (tower outage). Split screen, same seed: left is Runners (mesh), right is a central dispatch server. Central freezes. Mesh keeps delivering. | Resilience, common goal |
| 1:20 | A judge plays thief: clicks a rider and skims 1.2 kg. At the next hand-off the weight doesn't match. Leak Finder lights up: "box p-31 lost [1.2] kg while held by moto-04, cell C9-5". | The novel part |
| 1:45 | A judge plays hacker: breach the central server: [all] store locations, [all] stock levels, [N] clinic notes leak. Breach a mesh rider: [1] next hop, [0] stores, [0] child data. | The novel part |
| 2:10 | Network back. Ledgers merge on screen: "[142] boxes: [131] delivered intact, [3] skimmed (hop named), [4] lost in breakdowns, [2] in transit, [2] duplicates caught." | Technical execution |
| 2:30 | Sweep chart: share of boxes reaching clinics intact vs % carriers lost, mesh vs central, network down. Then one slide: same engine for disasters, vaccines, hospitals (section 11). Close. | Impact, technical execution |

---

## 3. How it works

### 3.1 The world
- Fictional 40 km x 40 km rural district. Hills, one river with a lake, 10 villages on dirt roads. Fictional place names. No real country.
- Grid of 2 km cells (`C{col}-{row}`). Labels and receipts only ever use cells, never exact positions.
- Nodes:
  - 1 district store + 2 sub-stores (west side). Hold stock. Share one "store network" key pair.
  - 10 clinics (outpatient nutrition sites) in villages. Generate demand, send sealed requests, receive boxes.
  - Carriers, about 22: 8 drones, 8 motorbikes, 4 vans, 2 boats.
  - 1 dispatch server, used only in central mode.
- Speeds (config): drone 25 m/s, motorbike 12 m/s, van 9 m/s on roads, boat 5 m/s. The sim runs faster than real time (speed slider).

### 3.2 Comms model (three layers)
1. **Cell network.** Only exists near towns (a coverage map in config). The NETWORK DOWN button switches every tower off.
2. **Local mesh radio** between nodes in range: drone 3 km, motorbike 2 km, van 3 km, boat 3 km, store/clinic 4 km. Messages hop between nodes in range (store and forward, max 6 hops).
3. **Dead zones.** Storms or hills, drawn by the presenter or a judge. Inside one, local radio is dead.

### 3.3 Carrier tiers (this is what hides the stores)
- **Vans** are the only carriers that ever visit a store. They run store to hand-off points.
- **Motorbikes and boats** run hand-off point to hand-off point, or hand-off point to clinic.
- **Drones** run hand-off point to clinic. They charge from a parked van, never at a store.
- So a breached drone or motorbike cannot know where a store is.

### 3.4 Lifecycle of one request
1. **Demand** at a clinic (scenario generator, seeded): new admissions of malnourished children.
2. **Request.** The clinic writes a manifest (item codes + quantities + a beneficiary note with counts only, e.g. "12 children 6-59 months, 3 new") and seals it to the store network key. The outside carries only: requestId, attempt, urgency (3 levels), size class, cold flag, destCell, deadline, and the clinic's public key. The enrolment list never leaves the clinic.
3. **Carried back by mules.** Any carrier in range picks up the envelope and passes it toward the stores. With signal, it arrives instantly.
4. **Claim.** A store decrypts, broadcasts `claim(requestId)` to stores it can reach, and packs a box. If two stores can't hear each other, both may pack. The duplicate is caught later.
5. **Seal the box.** The store seals the manifest (including declared weight) to the clinic's key. All boxes use the same outer packaging. The label carries only what routing needs.
6. **Relay.** Carriers pass the box along (3.5). Every hand-off makes a receipt signed by both sides with the cell and the **weight measured on receipt**.
7. **Last mile.** When a carrier holding a box enters its destCell, it calls on short range: "box for this cell, id hash". The clinic answers with a reply signed by its key. The carrier delivers only to a valid signed reply, so a box can't be handed to a fake "clinic". The clinic opens the box and checks contents and weight against the sealed manifest.
8. **Confirmation.** The delivered receipt travels back by mule. If a deadline passes with no delivery, the clinic re-requests (attempt + 1). That is where duplicates come from.

### 3.5 Hand-off rule (the agent brain: simple and explainable)
Every tick each carrier:
1. Reads its inbox and updates its neighbour table from beacons.
2. Broadcasts a beacon: id, kind, position, next 3 cells it plans to pass, spare capacity, and labels it holds (packageId, destCell, urgency only).
3. For each box it holds, compares its own ETA to destCell with each neighbour's ETA (`map.eta`), respecting tier rules and adding the cost of meeting.
4. If a neighbour beats its ETA by more than 20% and has capacity, it proposes a hand-off. They meet at a point offset at random 100-300 m from the midpoint, so hand-off spots never repeat. The engine executes the transfer when both are within 25 m. Both sign a receipt carrying the weight the receiver measured. The meeting point is wiped from memory after use.
5. Urgency 3 boxes go first. Drones on low battery go to the nearest parked van.
6. Every decision writes one plain line to its log, e.g. "Handing box p-17 to van-02: its ETA to C12-7 is 18 min vs my 31 min."

### 3.6 Ledger and the Leak Finder
- Each node keeps an append-only list of signed receipts. Receipts gossip between nodes in range (merge = union, verify signatures).
- For each box, the receipts form a chain: store → A → B → ... → clinic. Each receipt carries the weight measured by the receiver.
- **Leak Finder:** if the weight on the receipt where A handed to B is lower than on the receipt where A received the box, the loss happened while A held it. The panel names A, the cell and the kg.
- Classification after merge: delivered intact, delivered short (clinic found a mismatch against the sealed manifest), skimmed (hop named), stolen (box vanished, last holder named), lost in breakdown (last holder broke down), in transit, duplicate.
- Checks: no receipt with a bad signature, no delivery without a valid clinic reply, no non-van carrier ever learned a store location.

### 3.7 Central baseline (the fair comparison)
- A dispatch server sees everything over the cell network: all stores, all stock levels, all clinics, all open requests with manifests. Every 5 s it assigns carriers greedily, store to clinic, direct, no relays.
- Every device holds the common picture. Do not name any real system.
- Network down: carriers finish their current order, then hold. Requests can't reach dispatch.
- Theft in central mode is only noticed at the clinic, with no hop named, because there are no signed hand-off weights.
- Same seed, same demand, same sabotage, side by side.

### 3.8 Raiders (P1)
- Raiders watch van movements and look for "dwell points" (a van stays within 30 m of a spot for more than 20 s), cluster them, and guess store locations. A guess within 300 m of a real store = a successful raid, which removes stock.
- Mesh: only vans visit stores and hand-off points rotate, so guesses are worse. Central: direct repeated trips make stores obvious.
- Show it as a heat map toggle in the Thief View panel.

### 3.9 What "breach" returns (`dump()`)
- Mesh carrier: readable labels (cells, urgency, size), next hop id, 0 store locations (except vans), 0 stock levels, 0 beneficiary notes.
- Central carrier or dispatch: the full common picture.
- Exposure score = exact store locations + known stock levels + readable beneficiary notes. Show both sides.

---

## 4. Tech stack and why

| Choice | Why |
|---|---|
| TypeScript, Vite | One language for sim, UI and tests. Fast dev server. |
| three.js | 3D map with no map tiles or API keys, so it works offline on stage. |
| simplex-noise | Terrain height in a few lines. |
| Chart.js | The charts. |
| WebCrypto (built into browser and Node 24) | Real sealing and signatures with no crypto library. P-256 ECDH + AES-GCM to seal, ECDSA P-256 to sign. |
| vitest + tsx | Tests and headless sim runs from the terminal. |

Hard rules:
- **Everything works offline.** No CDN, no Google Fonts, no remote models. Turn wifi off before the demo, because the demo cuts the network.
- **Seeded randomness** (mulberry32) for every sim decision, so the demo replays the same way every time.
- `tick()` is async because WebCrypto is async. The engine awaits all agents each tick with `Promise.all`.
- 2 ticks per sim-second (`TICK_DT = 0.5`). Rendering interpolates at 60 fps. Speed slider 1x-60x.
- Apply agent actions in sorted NodeId order after `Promise.all`, so async timing never changes the result.

---

## 5. Repo layout and who owns what

Only the owner edits a folder. Only the lead edits `package.json`, `src/contracts/` and `src/main.ts`. Need a contract change? Ask the lead.

```
runners/
  PLAN.md                 this file
  package.json            LEAD
  index.html              LEAD
  src/
    contracts/            LEAD, frozen after hour 0
      types.ts
      config.ts           every number in section 3 + the item catalogue
    sim/                  WP1  engine, world, network, scenario, rng
    agents/               WP2  carrier, store, clinic, routing, lastmile
    privacy/              WP3  seal, sign, breach/exposure
    ledger/               WP4  receipts, merge, leak finder, invariants
    render/               WP5  three.js scene
    ui/                   WP6  controls, panels, charts
    baseline/             WP7  central dispatch, raiders
    main.ts               LEAD integration
  scripts/
    headless.ts           WP1
    sweep.ts              WP7  writes public/sweep.json
  tests/                  each WP adds its own *.test.ts
```

Proof of decentralisation (judges will ask): `src/agents/` must never import from `src/sim/`. A test greps for it and fails the build. Agents only see `AgentView`.

---

## 6. Frozen contract

The source of truth is the real file **`src/contracts/types.ts`** (types and every interface between WPs) plus **`src/contracts/config.ts`** (every number and the item catalogue). Both already exist and compile. Read them before writing code. Do not copy types into your own files; import them.

Already built by the lead, use freely:
- `src/privacy/core.ts`: `generateKeySet`, `seal`, `open`, `sign`, `verify`, `canonical`, `nonce`, base64 helpers. Tested in `tests/core.test.ts`.
- `src/agents/index.ts` and `src/baseline/index.ts`: stub factories so everything compiles now. WP2 and WP7 replace them, keeping the exported names `meshFactories` / `centralFactories`.
- `src/render/dev.ts`, `src/ui/dev.ts`: stub dev pages, opened at `/?dev=render` and `/?dev=ui`.
- `tests/core.test.ts`: includes the decentralisation test (agents must never import from `src/sim`).

---

## 7. Timeline (assumes about 6 hours from T0; confirm the real deadline first)

| Window | What | Done when |
|---|---|---|
| T0 to T0:30 | Lead: scaffold Vite TS, install deps, write `types.ts` + `config.ts`, git init | `npm run dev` shows a blank canvas; `npm test` runs |
| T0:30 to T3:30 | WP1-WP7 in parallel | Each WP passes its acceptance check (section 8) |
| T2:00 | Checkpoint: WP1 + WP2 run headless end to end | `npx tsx scripts/headless.ts --seed 7` prints metrics with deliveredIntact > 0 |
| T3:30 to T4:30 | Lead integrates `main.ts`, split screen, event wiring | Full demo runs once without errors |
| T4:30 | **Feature freeze.** Bug fixes only. | |
| T4:30 to T5:15 | Polish, lock the demo seed, rehearse twice with wifi off | Same run twice |
| T5:15 to T6:00 | Devpost write-up, screenshots, video if required, buffer | Submitted to the right track |

Cut order if behind (cut from the bottom first):
- P0 must have: sim core, carriers + hand-off + last mile, sealing, signed receipts with weights, Leak Finder, 3D map, NETWORK DOWN, dead zone, breakdown, skim, breach, metrics.
- P1 should have: central split screen, raiders heat map, sweep chart, auditor copy of each manifest, clinic and carrier certificates (2-of-3 signatures, "ghost clinic" refused), signed messages with replay protection, and the **Attack Console** (section 12).
- P2 nice to have: boats and lake, drone battery, secrecy dial (section 11), cold-chain temperature in receipts.

---

## 8. Agent briefs (paste one per coding agent)

Shared preamble for every agent:
> You are building one part of Runners, a hackathon project. Read `PLAN.md` in full first. Code against `src/contracts/types.ts` and `src/contracts/config.ts` exactly. Edit only files in your folder plus your own `tests/<wp>*.test.ts`. Do not edit `package.json`, `src/contracts/` or `src/main.ts`; if you need a contract change, stop and say what and why. Do not add dependencies. Do not launch subagents. TypeScript strict mode. Keep it simple, small and readable: judges may read the code. Build your P0 work first and pass your acceptance check. Only then build the section 12 items tagged with your WP and P1. Items tagged "Roadmap" are pitch-only: do not build them. Finish by running your acceptance check and reporting the output.

### WP1: Sim engine (`src/sim/`, `scripts/headless.ts`)
- `rng.ts`: mulberry32 seeded RNG.
- `world.ts`: terrain height function, river and lake polygons, 10 villages, dirt-road graph, cell signal coverage map, node placement per 3.1; implements `MapQuery` (drones straight line, vans/motorbikes on roads, boats on water).
- `network.ts`: radio range by kind, dead zones, cell network toggle, store-and-forward with max 6 hops; builds each agent's `neighbours`, `inbox`, `cellSignal`.
- `engine.ts`: owns physical truth (positions, boxes and their real weights, alive/broken, battery). Each tick: build `AgentView`, `await Promise.all(agents.tick)`, apply actions, run transfers (25 m rule, capacity), move carriers, apply `WorldEvent`s (skim removes kg from a box on the target; steal removes a box; breakdown kills a carrier and its boxes; raid removes store stock), compute `Metrics`, emit a snapshot for the renderer. Supports `mode: 'mesh' | 'central'`.
- `scenario.ts`: seeded demand generator (rises at t = 60 s) plus the scripted demo events.
- Acceptance: `npx tsx scripts/headless.ts --seed 7 --mode mesh --minutes 30` prints a metrics table every sim-5-minutes and finishes in under 30 s real time. Test: same seed gives identical metrics twice.

### WP2: Agent brain (`src/agents/`)
- `carrier.ts`: hand-off rule (3.5), tier rules (3.3), last-mile call and signed-reply check (3.4 step 7), wipes meeting points after use, signs receipts with the measured weight, plain-English log lines, `dump()` per 3.9.
- `store.ts`: open requests (via WP3), claim broadcast, pack and seal boxes, load onto vans by urgency.
- `clinic.ts`: create sealed requests from demand (counts only), answer last-mile calls with a signed reply, open and check boxes against the sealed manifest, report short deliveries, re-request after deadline, count duplicates.
- `routing.ts`: ETA comparison and meeting-point choice. Pure functions, unit tested.
- Never import from `src/sim/`. Only use `AgentView`.
- Acceptance: unit tests for the hand-off decision (neighbour 20% faster gets the box, slower doesn't, tier violation refused); with WP1, a headless mesh run delivers more than 80% of requests with the network up.
- Hardest WP. Strongest model here.

### WP3: Privacy (`src/privacy/`)
- `seal.ts`: `generateKeyPair()`, `seal(obj, recipientPub)` (ephemeral ECDH P-256 → AES-GCM 256), `open(sealed, privKey)`, base64 helpers. P1: `sealTwice(obj, clinicPub, auditorPub)` for the auditor copy.
- `sign.ts`: ECDSA P-256 `sign` / `verify` over canonical JSON (sorted keys). P1: `issueCert(nodeId, role, expiry, signers)` and `verifyCert(cert, authorityPubs, threshold = 2)`.
- `breach.ts`: `exposureScore(dump)` = store locations + known stock levels + readable beneficiary notes; `summarise(dump)` returns the lines the Breach card shows.
- Same code runs in browser and Node 24 (`globalThis.crypto.subtle`).
- Acceptance tests: seal/open round-trip; wrong key throws; tampered receipt fails verify; mesh dump scores lower than central dump; (P1) cert with 1 of 3 signatures fails, 2 of 3 passes.

### WP4: Ledger (`src/ledger/`)
- `receipts.ts`: append-only store keyed by `packageId:kind:from:to:t`, verify on insert, reject bad signatures.
- `merge.ts`: union of two stores; merge order must not change the result (test it).
- `leaks.ts`: **the Leak Finder.** Walk each box's receipt chain; when weight drops between the receipt into a holder and the receipt out of it, report `{packageId, holder, cell, kgLost}`; when a chain ends at a holder with no breakdown, report stolen with last holder.
- `invariants.ts`: classify each box (3.6) and return a report object for the UI.
- Acceptance tests: merge is order-independent; A→B→C with C's outgoing weight 1.2 kg lower names C; a chain ending at a working carrier counts as stolen with that carrier named; two deliveries for the same requestId+attempt = 1 duplicate; forged receipt rejected.

### WP5: 3D renderer (`src/render/`)
- `scene.ts`: three.js scene, OrbitControls, warm daylight, light haze. Export `createRenderer(canvas)` with `update(snapshot)`.
- `terrain.ts`: height mesh, river and lake, dirt roads, villages as small hut clusters, clinic markers, cell grid toggle, fictional place labels.
- `entities.ts`: low-poly meshes per kind (fixed-wing drone, motorbike with rider, white van, small boat); every box is the same plain crate with a soft glow; fading trails; thin lines between nodes in radio range; broken-down carriers turn grey.
- `zones.ts`: dead zones as dark storm cylinders; NETWORK DOWN greys out the tower icons.
- `picking.ts`: click to select a node (`onSelect(id)`); click-drag on the ground to place a dead zone in zone mode.
- 60 fps with about 35 nodes on a laptop; interpolate between snapshots.
- Acceptance: a demo page with a fake snapshot generator shows everything moving at 60 fps; selection and zone placement work.

### WP6: UI (`src/ui/`)
- `controls.ts`: top bar: NETWORK DOWN / UP, Dead zone tool, Breakdown tool, Thief tool (skim kg or steal box), Hacker tool (breach a node), Mode (mesh | central | split), speed slider, Reset to seed. Emits `WorldEvent`s.
- `metrics.ts`: live panel (reach %, delivered intact, skimmed, stolen, lost, in transit, duplicates, mean delivery time, carriers alive) and a live reach-over-time chart; two lines in split mode.
- `inspector.ts`: selected node: kind, what it knows (labels only), next hop, last 15 log lines.
- `leakFinder.ts`: list of pinpointed losses (box, holder, cell, kg), clicking one highlights that carrier and its route on the map.
- `breachCard.ts`: breach result (exposure score + WP3 `summarise` lines), mesh vs central side by side.
- `ledgerView.ts`: the merge report after NETWORK UP.
- `charts.ts`: sweep chart from `public/sweep.json`.
- Big, legible, readable from the back of a room.
- Acceptance: all panels render with mock data; every button emits the right `WorldEvent`.

### WP7: Baseline and raiders (`src/baseline/`, `scripts/sweep.ts`)
- `central.ts`: central-mode agents per 3.7 (dispatch greedy assignment every 5 s; carriers obey orders; every device holds the full picture; `dump()` returns it all). Same `Agent` interface.
- `raiders.ts`: dwell-point detection on van tracks, clustering, store guesses, raid success score (3.8).
- `scripts/sweep.ts`: for each mode and breakdown fraction in [0, 0.1, ..., 0.6], run headless with NETWORK DOWN at t = 300 s for 3 seeds, average reach %, write `public/sweep.json`.
- Acceptance: with the network down, central reach stalls while mesh keeps rising; raider score central > mesh on seed 7; sweep finishes in under 5 minutes.

### Lead: integration (`src/main.ts`)
- Wire engine → renderer → UI, split screen (two engines, same seed, events mirrored), demo script runner (a key fires the next scripted event), lock the demo seed.
- Offline test: wifi off, `npm run build && npx vite preview`, full demo twice.

Model per agent: WP2 and the lead on the strongest model. WP1, WP3, WP4, WP5, WP6, WP7 on a fast model (e.g. Sonnet) at medium effort.

---

## 9. Questions judges will ask

| Question | Answer |
|---|---|
| Clinics are public. Why hide anything? | Clinics are public. What we hide is what's in each box, where the stores are, stock levels, and which children are enrolled. Theft goes after value it can identify. |
| A thief can just steal everything. | Yes, and then the ledger names the hop. The big losses come from insiders, and an insider who knows they will be named steals far less. We make theft attributable, not impossible. |
| Swap sachets for sand and the weight still matches. | The clinic opens every box and checks it against the sealed manifest, so a swap shows up as a short delivery traced back along the same chain. Nothing is foolproof. |
| Are you surveilling poor mothers? | No. Tracking stops at the clinic. Clinic staff hand food to families. MSF's own research says full cartons found for resale most likely come from inside the supply chain. |
| You said exactly once. Two groups can serve the same request. | We don't claim it. No box is lost without a record, duplicates are caught and counted on merge, and the ledger panel shows the rate. |
| Who holds the whole map? | Nobody. Clinics seal their own requests, stores seal boxes to the clinic's key, carriers see one next hop and a 2 km cell. Only vans know where stores are. |
| How do you stop fake clinics? | A carrier only delivers to a reply signed by a real clinic's key. (P1) Clinic keys need 2 of 3 signatures (health ministry, NGO, auditor), so no single party can create a ghost clinic. |
| Where is the AI? | Each agent plans alone under uncertainty: who to hand to, where to meet, when to re-request, from only what it senses. No central brain. |
| Prior art? | Drone delivery to clinics already exists with central dispatch (e.g. Zipline). Swarm allocation (CBBA), delay-tolerant networking and supply-chain tracking pilots all exist. We found nothing that keeps working offline between agents, hides contents and stock, and names the hop where loss happened. Say "we found none", never "none exists". |

Facts safe to use on slides (verified, with source):
- RUTF meant for malnourished children has been found stolen and sold in markets in north-east Nigeria (HumAngle; Daily Trust).
- MSF's research unit (CRASH): complete cartons found at resale sites are most likely diverted by people within the health system, NGOs or UN agencies.
- 2023: USAID and WFP suspended food aid across Ethiopia over a diversion scheme officials said may have been the largest theft of food aid in history, including manipulated beneficiary lists (PBS/AP; WFP statement).
- Jan 2022: a cyber attack on the ICRC compromised data on more than 515,000 highly vulnerable people (ICRC).

Do not use: anything set in an active war (keep it a fictional rural district), unverified malnutrition statistics, brand names (say RUTF, not a brand).

---

## 10. Before you submit (checks that sink teams)

- [ ] Submission deadline confirmed on Devpost or with organisers.
- [ ] Submitted to the **Neptune North** track (check the track name on the form, not only the overall prize).
- [ ] Repo public (if required); README has the one-paragraph idea and how to run.
- [ ] Demo runs with wifi off.
- [ ] Demo seed locked; rehearsed twice end to end inside 3 minutes.
- [ ] Every number on slides comes from the live run or the verified list in section 9.
- [ ] Neptune North workshop (16:45, Theatre A): ask what they want to see, then adjust the pitch, not the build.

---

## 11. Where else it works (the "bigger than one use" slide)

Same engine, one setting changed: a **secrecy dial** with three positions.

| Setting | What is hidden | Where it fits |
|---|---|---|
| **Open** | Nothing. Labels show contents and destinations so everyone can help. | Natural disasters (floods, earthquakes): towers are down, roads are cut, speed matters more than secrecy. The mesh routing, relays and ledger still work with no network. |
| **Guarded** (default) | Contents, stock levels, store locations. | Food aid and medicine to remote clinics where theft is the problem (this demo). |
| **Sealed** | Everything above plus any patient detail, even counts. | Sensitive medicine (HIV, TB) to rural patients who face stigma; refugee camps where beneficiary data must not leak. |

Other drop-in uses to mention, one line each:
- **Vaccines to remote villages:** the cold flag plus temperature in each receipt shows which hop broke the cold chain, the same way the Leak Finder names a weight loss.
- **Hospital labs under ransomware:** London hospital labs already fly blood samples by drone, and the same lab provider was hit by ransomware in 2024. Sealed labels mean a hacked drone or server leaks no patient data, and the mesh keeps moving samples while the network is down.
- **Search and rescue in remote areas:** drones, boats and ground teams share the relay and the ledger with the network down; set to Open.

Pitch line for this slide: "We built it for children's food. The same engine runs disaster relief with the secrecy turned down and patient medicine with it turned up."

---

## 12. Hardening: every attack a judge can throw, and our answer

### 12.1 The principle (say this before listing anything)
We don't stack encryption layers. More layers don't make a system safer, and engineers know it. We design so that **every attacker gets nothing worth stealing**:
- Carriers hold **no key that opens a box**. Boxes are sealed to the clinic, so stealing a carrier's keys opens nothing.
- **No single device** knows the whole picture, so no single breach leaks it.
- **Every action is signed**, so every loss has a name on it.
- **Nothing depends on the network**, so jamming or an outage slows us down but doesn't stop us.

Line for stage: "Hack any one device and you get one hop, no contents and no children. To steal quietly you'd need to corrupt several independent parties, and the ledger still names them."

### 12.2 Threat table

Tier: **P1** = build after P0 passes. **P2** = build only if time is left. **Roadmap** = pitch-only, never build at the hackathon.

| # | Attack | What the attacker wants | Our defence | Tier | Owner |
|---|---|---|---|---|---|
| 1 | Steal a rider's phone or a downed drone | Contents, stores, children | Carrier holds no box-opening key; only labels, one next hop, a 2 km cell. Meeting points wiped after use. | P0 | WP2, WP3 |
| 2 | Extract the device's own signing key | Pose as that rider | Certs last one sim-day, so a stolen key dies on its own. Roadmap: keys locked in the phone's hardware keystore so they can't be copied. | P1 / Roadmap | WP3 |
| 3 | Fake carrier joins the mesh to collect boxes (Sybil attack) | Boxes | Hand-offs only to nodes with a valid carrier cert signed by 2 of 3 authorities. Fake carrier refused, logged, counted in `attacksBlocked`. | P1 | WP2, WP3 |
| 4 | Ghost clinic requests food that gets resold | Boxes | Requests and last-mile replies must carry a valid clinic cert (2 of 3). Plus a demand check: a clinic asking for 3x its usual volume gets flagged for a human. | P1 | WP2, WP3 |
| 5 | Replay an old request or receipt | Duplicate boxes, confuse the ledger | Every message has a nonce and a signature; each node keeps a cache of seen nonces and drops repeats. requestId + attempt is unique. | P1 | WP3, WP2 |
| 6 | Tamper with a message in transit | Redirect a box | Every message signed by its sender; unsigned or bad signature = dropped and counted. Box contents use authenticated encryption (AES-GCM), so any change fails to open. | P1 | WP3 |
| 7 | Two dishonest carriers collude and sign a fake weight | Skim without being named | (a) The clinic opens every box and checks it against the sealed manifest, so total loss still shows, pinned to the stretch between the last honest weigh-in and the clinic. (b) **Pair rotation:** routing avoids repeat hand-offs between the same two carriers. (c) Carriers with repeated losses get fewer boxes. | P1 (a, b), P2 (c) | WP2, WP4 |
| 8 | Store staff pack short | Skim at the source | Every box signed by the packer's key; auditor copy of the manifest; clinic check names the packer when a box arrives short. | P1 | WP2, WP3, WP4 |
| 9 | Flood the mesh with junk messages (denial of service) | Stop deliveries | Signature check before forwarding; per-node rate limit; hop limit of 6; urgency-3 traffic goes first. | P1 | WP1, WP2 |
| 10 | Jam radios or cut the cell network | Stop deliveries | The core design: agents keep routing alone, carry messages physically, and merge when back. | P0 | all |
| 11 | Spoof GPS to fake a hand-off or misroute a carrier | Misroute boxes | Hand-off needs both sides to confirm proximity; position jumps faster than the carrier can move get flagged. Roadmap: radio ranging between devices instead of trusting GPS. | P2 / Roadmap | WP2 |
| 12 | Watch van movements to find stores (raiders) | Raid stores | Only vans visit stores, hand-off points rotate, timing gets random jitter. Optional decoy runs with a visible cost dial. | P1 (rotation), P2 (jitter, decoys) | WP2, WP7 |
| 13 | Read the label to guess contents (size + cold flag = vaccines?) | Pick valuable boxes | Uniform packaging; boxes padded to standard sizes; cold flag only when truly needed; the Sealed setting on the secrecy dial hides even size. | P2 | WP2, config |
| 14 | Breach a device holding lots of receipts | Route history, hand-off patterns | Carriers keep only receipts for boxes they touched, pruned once delivery is confirmed. P2: receipts sealed to the auditor so carriers can pass them on but not read them. | P1 (prune), P2 (seal) | WP4 |
| 15 | Steal the store network key | Read all requests | Each store has its own key; requests sealed separately to each store; keys rotate daily. Roadmap: threshold decryption, so 2 of 3 stores must cooperate to open a request. | P2 / Roadmap | WP3 |
| 16 | Clinic loses its phone (and its key) | Clinic can't open boxes | Key recovery split into 3 shares (district health office, NGO, auditor); any 2 restore it (Shamir secret sharing). | Roadmap | WP3 |
| 17 | Rider forced at gunpoint to hand over a box | The box, and silence | **Duress PIN:** the rider signs the forced hand-off with a second PIN; the receipt looks normal to the thief but is flagged "coerced" in the ledger, so the rider isn't blamed and the theft is reported. | P2 | WP2, WP4 |
| 18 | Clocks drift or get faked to reorder events | Confuse the ledger | Receipts ordered by a logical counter carried with each box, not wall-clock time. | P2 | WP4 |
| 19 | Hack the central server | Everything | There is no central server in mesh mode. The split screen shows the central version leaking everything. | P0 | WP7 |
| 20 | Push a malicious software update | Own every device | Roadmap: only signed builds install; reproducible builds so anyone can check the code matches. | Roadmap | none |
| 21 | Future quantum computers break the crypto | Read old boxes | Roadmap: add post-quantum key exchange alongside the current one. All crypto sits in one module (WP3) so it can be swapped. Don't overclaim. | Roadmap | WP3 |

### 12.3 Attack Console (P1, the demo's bulletproof moment)
A panel with one button per attack. A judge picks one; the engine fires the matching `WorldEvent`; the panel shows the outcome in one line and the `attacksBlocked` counter ticks up.

| Button | Engine does | What the panel says |
|---|---|---|
| Fake carrier | Spawns an uncertified carrier next to a loaded rider | "Hand-off refused: no valid carrier certificate" |
| Ghost clinic | Uncertified node sends a request | "Request dropped: no valid clinic certificate" |
| Replay | Re-sends an old delivered request | "Dropped: nonce already seen" |
| Tamper | Flips a byte in a message | "Dropped: bad signature from moto-04" |
| Collude | Two carriers fake a weight together | "Clinic found [1.4] kg short; loss pinned between van-02 and clinic-6" |
| Pack short | Store packs under weight | "Box short at clinic-3; packer key store-A named" |
| Flood | Node spams 500 messages | "Rate-limited; urgent deliveries unaffected" |
| Spoof GPS | Carrier position jumps 5 km | "Position jump flagged; hand-off refused" (P2) |
| Coerce | Rider hands over under duress | "Hand-off flagged coerced; rider not blamed" (P2) |
| Steal key | Copies a rider's signing key | "Key works until its cert expires at [t]; boxes still unreadable" |

Owners: WP6 builds the panel; WP1 applies the events; WP2/WP3/WP4 produce the rejections and log lines; the lead wires it.

### 12.4 What NOT to claim
- "Unhackable", "theft-proof", "military-grade", or "zero trust" as a slogan. Each one invites a judge to break it.
- Any number of "encryption layers".
- That roadmap items are built. Say "designed, not built today".

Say instead: "Every attack in this console is one we built a defence for. The ones on the roadmap slide we've designed but not built in 6 hours."


---

## 13. Stress test of this plan: holes found and patched (read before coding)

Each line is a question that would have broken the build or the demo, and the patch now in the contract. Where this section and earlier sections disagree, **this section wins**.

| # | Hole (the question) | Patch |
|---|---|---|
| 1 | Who signs a receipt if the giver drives out of range before countersigning? | The **receiver always signs** (`sigTo`). The giver's countersign (`sigFrom`) is optional. A receipt means "I, the receiver, got this box weighing X kg from A". |
| 2 | How does the next hop catch a skim live, offline, when the ledger only merges after the network returns? | Every box carries a **passport**: its receipt chain (`CarriedBox.passport`). The receiver compares its scale with the passport's last weight on the spot and raises a `weight-mismatch` alert immediately. Detection needs no network. |
| 3 | How does a receipt get onto the box? | New action `stamp`: the receiver appends its signed receipt to the box's passport. The engine moves the passport with the box on `transfer`. |
| 4 | How does a store prove it packed a box (for "pack short")? | `SealedBox.packedBy` + `packSig` (store signs `{label, sealed}`). |
| 5 | Keys must exist before the first tick. Who makes them? | `src/sim/setup.ts` (WP1) generates every node's `KeySet` with `core.ts`, plus 3 authority keys, the auditor key and the shared store key, and builds an `AgentSetup` per node. Certs are `null` until P1. |
| 6 | The engine would have to import WP2 and WP7 code that doesn't exist yet. | **Factories are injected**: `createEngine({ seed, mode, factories })`. The engine never imports agents. Stubs exist now, so everything compiles. |
| 7 | Renderer and UI need a data shape, and nobody defined it. | `Snapshot`, `NodeState`, `EngineApi`, `RendererApi`, `UiApi`, `LedgerReport` are now in the contract. |
| 8 | Without fixed meeting places, vans and drones never meet and routing stalls. | **3 relay hubs** (`map.hubs()`), known to carriers but never stores. Vans run store → hub. Drones park at a hub. Motorbikes and boats patrol loops past their clinics (`AgentSetup.patrol`) and act as mules. Meeting points are randomised 100-300 m around a hub or midpoint. The ETA rule then improves on this baseline. |
| 9 | Does the network carry messages, or do agents? | The network delivers a message the same tick to every node in the sender's radio-connected group (max 6 hops), or anywhere if both ends have cell signal. If there's no path, it's dropped. **Agents keep their own outbox** and re-send every `RESEND_EVERY` seconds, and carriers hold request envelopes and receipts and re-broadcast them when new neighbours appear. That's the physical "carrying". |
| 10 | Re-requests use attempt+1, so "same requestId + attempt" never counts as a duplicate. | A duplicate = a box delivered for a requestId that the clinic has already had filled. Clinics count it. |
| 11 | 10 ticks per second at 60x speed is 600 async ticks a second: too slow. | `TICK_DT = 0.5` (2 ticks per sim-second). Crypto runs only on events (hand-offs, requests), never every tick. |
| 12 | `Promise.all` finishes in random order, so replays could differ. | Engine applies actions in sorted NodeId order. Every agent gets its own seeded `rng`; `Math.random` is banned in sim and agents. |
| 13 | Two full 3D scenes in split mode would melt a laptop. | Split mode = main 3D scene for one mode + a **2D minimap** of the other (WP6), both engines stepping. |
| 14 | The demo starts with nothing moving. | `warmupSec` fast-forwards headless 30 sim-minutes before rendering (`WARMUP_SEC`). |
| 15 | WP5 and WP6 can't test without the engine. | Each builds `src/<wp>/dev.ts` exporting `mountDev(root)` with fake snapshots, opened at `/?dev=render` and `/?dev=ui`. |
| 16 | `npm run typecheck` fails while other WPs are half-done. | Each agent checks only its own files: `npx tsc --noEmit 2>&1 \| grep "src/<your folder>"` should print nothing, and `npx vitest run tests/<wp>` passes. Ignore errors in other folders. |
| 17 | Central mode needs stores and clinics too, not just carriers. | WP7's `centralFactories` implements all 7 node kinds for central mode (dispatch included). In mesh mode, `meshFactories.dispatch` is never instantiated. |
| 18 | Clinics are public, so last-mile rendezvous offsets add nothing. | Dropped. The last mile proves the receiver is a real clinic (signed reply). Secrecy is about stores, stock, contents and children. |
| 19 | Live Leak Finder vs merged ledger: which does the UI show? | Live: alerts (`Snapshot.newAlerts`) as each hop detects them. On NETWORK UP: `buildReport(engine.ledgerInput())` from WP4 gives the full classification. |
| 20 | Git: parallel agents committing would collide. | No git during the build. Folders are disjoint; only the lead touches shared files. |

### Brief addenda (each WP: read your line)
- **WP1:** export `createEngine` (type `CreateEngine`) from `src/sim/engine.ts`; write `src/sim/setup.ts` (patch 5), hubs and patrols (8), message delivery (9), action ordering (12), warmup (14), all `WorldEvent`s (P0 ones first; attack-console ones P1). For your own tests use a tiny local dummy agent, not WP2's.
- **WP2:** replace `src/agents/index.ts` (keep `meshFactories`). Implement passport checking and `stamp` (1-3), packing signature (4), outbox and re-send (9), duplicate counting (10). Use `core.ts` for all crypto. Unit-test pure logic in `src/agents/routing.ts`.
- **WP3:** `core.ts` is done; don't rewrite it. Build `src/privacy/certs.ts` (2-of-3 certs), `src/privacy/breach.ts` (exposure score, summary lines), `src/privacy/auditor.ts` (auditor copy helpers), `src/privacy/guard.ts` (signed messages, nonce cache, rate limiter: helpers WP2 calls). Tests for each.
- **WP4:** export `buildReport(input: ReturnType<EngineApi['ledgerInput']>): Promise<LedgerReport>` from `src/ledger/index.ts`; verify every receipt signature with `signPubs`; walk passports and gossiped receipts.
- **WP5:** export `createRenderer(canvas: HTMLCanvasElement): RendererApi` from `src/render/index.ts`; replace `src/render/dev.ts`.
- **WP6:** export `createUI(root: HTMLElement, h: UiHandlers): UiApi` from `src/ui/index.ts`; replace `src/ui/dev.ts`; the 2D minimap (13) and the Attack Console panel (section 12) live here.
- **WP7:** replace `src/baseline/index.ts` (keep `centralFactories`, all 7 kinds, 17); `src/baseline/raiders.ts`; `scripts/sweep.ts` importing `createEngine`, `meshFactories`, `centralFactories`.
