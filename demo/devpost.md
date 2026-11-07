# Runners

Sealed crates of children's food, moved by a fleet that keeps working when the network goes down and names the hand-off where anything went missing.

GreatUniHack 2026, Neptune North track.

**The scenario is a simulation on real geography.** The map of Hawassa, Ethiopia uses real roads, real villages, Lake Hawassa and real elevation. The deliveries, thefts, clinics' requests and every number in the demo come from our simulator. Nothing in it describes a real theft at any real facility in Hawassa.

## Inspiration

Therapeutic food for severely malnourished children (RUTF, a peanut paste) gets stolen and resold. It has been found for sale in markets in north-east Nigeria (HumAngle; Daily Trust). MSF's research unit found that full cartons at resale sites were most likely diverted by people inside the health system, NGOs or UN agencies (MSF CRASH). In 2023, USAID and WFP suspended food aid across Ethiopia over a diversion scheme that officials said may have been the largest theft of food aid in history, including manipulated beneficiary lists (PBS/AP; WFP statement).

Today the paperwork travels with the food. A manifest on a van says what each carton holds, where it's going and where the stores are. Stock is tracked by hand and losses turn up later in a count, with no name on them. A stolen phone exposes the lot, and aid data does get breached: a 2022 cyber attack on the ICRC compromised data on more than 515,000 highly vulnerable people (ICRC).

The Neptune North brief asked for agents that keep working toward a shared goal when communication fails. Remote clinics are exactly where the signal drops.

## What it does

Every vehicle in the fleet (drones, motorbikes, vans, boats) carries a black box: the agent device. It knows which sealed crate goes to which clinic and tells the crew only the next step. The crew never records what's inside or who it's for.

The demo runs two simulations side by side on one seed, with the same requests and the same events. The left side is today's way, with one central dispatch server that every device copies. The right side is Runners.

- **Insider skim.** We take 1.2 kg from a crate on both sides. On the left nobody is alerted. On the right the next vehicle weighs the crate when it takes it, and the Leak Finder names the vehicle that held it and the 2 km cell it was in.
- **Stolen device.** Breach the van's phone on the left and it gives away every store location and the clinics' notes on children. Breach a Runners black box and it holds its next stop and no store locations or child data.
- **Network down.** Every cell tower goes off. Central dispatch stops hearing new requests. The Runners fleet keeps routing on its own, drones in range relay messages between vehicles, and requests ride on the vehicles themselves.
- **Glass box.** When the network returns, the signed receipts every vehicle carried merge into one ledger. An auditor sees each crate's chain of custody with the weight at every hand-off.
- **Scoreboard.** The demo closes on live numbers for both sides: delivered intact, delivered during the outage, losses with the holder named, and what one stolen device exposes.

## How we built it

- **Simulator.** TypeScript. A seeded engine (mulberry32) steps every agent twice per sim-second and applies their actions in sorted order, so a seed replays the same way. Radio range, store-and-forward up to 6 hops, cell coverage near towns, and a NETWORK DOWN switch.
- **Agents.** Each vehicle decides alone from what it can sense: who to hand a crate to (a neighbour must beat its own ETA by 20%), where to meet, when to re-send. The agent code never imports the simulator; a test fails the build if it does.
- **Sealing and signatures.** WebCrypto only: P-256 ECDH with AES-GCM seals each manifest to the clinic's key, ECDSA P-256 signs every hand-off receipt with the weight the receiver measured. Clinics send requests with counts only.
- **Ledger and Leak Finder.** Receipts merge as a union, verified on insert. The Leak Finder walks each crate's chain and flags the holder whenever the weight out is lower than the weight in.
- **Baseline.** A central dispatcher that assigns vehicles greedily from a full common picture, so the comparison is fair.
- **Map.** Roads, villages, water and health sites from OpenStreetMap via the Overpass API; elevation from the Copernicus DEM via Open-Meteo; imagery from Sentinel-2 cloudless. Rendered in three.js with no tile server, so the demo runs with wifi off.
- **Demo director.** A scripted timeline that only fires world events and moves the camera, with captions built from the live run.

## Challenges we ran into

- WebCrypto is async, and `Promise.all` finishes in a random order. We apply actions in sorted id order after every tick so replays stay identical.
- A receipt needs the receiver's signature even when the giver has already driven out of range, so the receiver always signs and the giver's countersign is optional.
- Catching a skim offline. The ledger only merges when the network returns, so every crate carries its own receipt chain and the receiving vehicle checks its scale against it on the spot.
- Running two simulations side by side on one laptop, and moving from a made-up district to real roads around a real lake.

## Accomplishments that we're proud of

- The theft gets caught at the next hand-off with no network at all.
- A breached black box gives away its next stop, with zero store locations and zero notes on children.
- The same run on the same seed, side by side with today's way, so every difference on screen comes from the design.

## What we learned

- Giving each device less to know protected more than any extra layer of encryption could.
- When groups get cut off, two of them can serve the same request. We count those duplicates and name the hop where loss happened, and we dropped any promise of exactly-once delivery.
- The hard part of agents working offline is the paperwork afterwards: merging receipts so the ledger comes out the same whichever order they arrive in.

## What's next

- Run it on real phones in the vehicles, with keys held in the phone's hardware keystore.
- A secrecy setting: turned down for disaster relief where speed matters most, turned up for sensitive medicine where even counts must stay private.
- Temperature in each receipt, so the same ledger shows which hop broke a vaccine cold chain.
- A pilot conversation with an NGO running outpatient nutrition sites.

## Built with

TypeScript, Vite, three.js, simplex-noise, Chart.js, WebCrypto (ECDH P-256, AES-GCM, ECDSA P-256), Vitest, tsx, OpenStreetMap (Overpass API), Copernicus DEM (via Open-Meteo), Sentinel-2 cloudless by EOX.

## Credits

- Map data (c) OpenStreetMap contributors, available under the Open Database License (ODbL).
- Elevation: Copernicus DEM, served by Open-Meteo.
- Imagery: Sentinel-2 cloudless 2020 by EOX IT Services GmbH (contains modified Copernicus Sentinel data 2020), CC BY-NC-SA 4.0.
