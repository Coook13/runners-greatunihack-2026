# Runners

GreatUniHack 2026, Neptune North track: "multiple agents keep working toward a shared goal, even when communication fails."

Food meant for malnourished children is stolen and resold, mostly by people inside the supply chain. Today aid workers carry manifests listing what is in every carton and where it goes, so a stolen clipboard exposes every clinic, and losses show up weeks later at a stock count.

Runners puts a black box agent in every drone, motorbike, van and boat. It knows which sealed crate goes to which clinic and tells the crew only the next step. Every hand-off is signed and weighed, so the Leak Finder names the exact hand-off where food went missing. A stolen device gives away one next stop: no store locations, no notes on children. Auditors get a glass box: with the auditor key they can open every manifest and follow each crate's chain of custody. When the phone network goes down, the agents keep routing on their own and merge their records when it comes back.

The simulation runs on the real map of Hawassa, Ethiopia. The deliveries are simulated.

## Run it

```bash
npm install
npm run dev
```

Then open http://localhost:5173/

- `/` single map (Runners). The "Compare with today" tab shows today's central dispatch side by side.
- `/?autoplay=1` the 3-minute guided demo with the fly-in from Ethiopia.
- Keys: Space play/pause, + and - speed (up to 300x), ] skip an hour, Tab panels, G glass box, S comparison chart, H hide UI, ? help.
- Click any vehicle to see its black box.

Everything works offline once installed.

## Results (headless, real Hawassa map, 4 seeds)

| | Runners | Today (central dispatch) |
|---|---|---|
| Network up: requests delivered intact | 92-97% | 46-74% |
| Network up: mean delivery time | 14-17 min | 11-12 min |
| Network down for 2 h: extra boxes delivered | +8 | 0-1 |

Reproduce: `npx tsx scripts/headless.ts --seed 7 --mode mesh --minutes 240` (and `--mode central`), `npx tsx scripts/sweep.ts`.

## How it is built

- TypeScript, Vite, three.js. Each vehicle, store and clinic is its own agent and only sees what is in its radio range. `tests/core.test.ts` fails the build if agent code ever reads the simulator's global state.
- Crypto with WebCrypto: P-256 ECDH + AES-GCM to seal manifests, ECDSA to sign receipts, requests and hand-offs. 2-of-3 certificates for clinics and carriers.
- 182 tests: `npx vitest run`.
- Plan and contract: `PLAN.md`, `src/contracts/types.ts`.

## Data and credits

- Imagery: Sentinel-2 cloudless 2020 by EOX IT Services GmbH (contains modified Copernicus Sentinel data), CC BY-NC-SA 4.0.
- Roads, places, lake: © OpenStreetMap contributors (ODbL).
- Elevation: Copernicus DEM via Open-Meteo.
- Ethiopia border and national roads: Natural Earth (public domain).
