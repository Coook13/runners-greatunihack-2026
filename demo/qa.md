# Judge Q&A

One line each. Say "we found none", never "none exists". Say "designed, not built today" for anything on the roadmap.

## The idea

**Clinics are public. Why hide anything?** We hide what's in each crate, where the stores are, stock levels and which children are enrolled, because theft goes after value it can identify.

**What changes for aid workers?** The black box tells the crew the next step, so nobody carries a manifest or tracks stock by hand.

**Who sees everything?** Only the auditor, through the glass box, with the auditor key.

**Why Hawassa?** It gave us real roads, a real lake for the boats and real hills. The deliveries and thefts are simulated and say nothing about real facilities there.

**Are you surveilling poor mothers?** No. Tracking stops at the clinic, clinic staff hand food to families, and requests carry counts only.

## Theft

**A thief can just steal everything.** Yes, and then the ledger names the hop; we make theft attributable, and an insider who knows they'll be named steals far less.

**Swap sachets for sand and the weight still matches.** The clinic opens every crate and checks it against the sealed manifest, so a swap shows up as a short delivery traced along the same chain.

**Two carriers collude and fake the weight.** The clinic check still catches the total loss and pins it to the stretch after the last honest weigh-in, and routing avoids repeat pairs.

**Store staff pack short.** Every crate is signed by the packer's key, so a short crate at the clinic names the packer.

**Rider forced at gunpoint.** Designed: a duress PIN flags the hand-off as coerced so the rider isn't blamed (P2, check whether it's built before claiming it).

## Hacking

**What does a stolen black box give away?** Its next stop and the 2 km cells on its labels, with zero store locations and zero child data.

**They steal the device's signing key.** Certificates last one sim-day, so the key dies on its own, and it never opens a crate.

**A fake carrier joins to collect crates.** Hand-offs only go to vehicles with a certificate signed by 2 of 3 authorities, so it's refused and logged.

**A ghost clinic orders food to resell.** Requests and delivery replies need a clinic certificate signed by 2 of 3 authorities, and a clinic asking for 3 times its usual volume is flagged.

**Replay an old message.** Every message has a nonce and a signature, and nodes drop any nonce they've already seen.

**Hack the central server.** In Runners there isn't one; the left side of the demo shows what that breach leaks.

**Quantum computers?** All crypto sits in one module so it can be swapped; post-quantum key exchange is roadmap, designed, not built.

**How many layers of encryption?** We don't count layers; we design so each device holds nothing worth stealing.

## Resilience

**What happens when the network drops?** Each vehicle keeps routing on what it can sense, drones in range relay messages, and requests ride on the vehicles until the towers return.

**Jam the radios.** Vehicles carry messages physically and merge when they meet, so jamming slows delivery and doesn't stop it.

**Flood the mesh with junk.** Signature check before forwarding, a per-node rate limit, a 6-hop limit, and urgent crates go first.

**Spoof GPS.** A hand-off needs both sides to confirm they're close, and impossible jumps get flagged (P2; radio ranging is roadmap).

**You said exactly once.** We don't claim it: two cut-off groups can serve one request, and the ledger catches and counts the duplicate.

## Tech

**Where's the AI?** Each agent plans alone under uncertainty: who to hand to, where to meet and when to re-request, with no central brain.

**Is it really decentralised?** The agent code never imports the simulator, and a test fails the build if it does.

**Is the crypto real?** Yes, WebCrypto: ECDH P-256 with AES-GCM to seal, ECDSA P-256 to sign every receipt.

**Same seed, same run?** Yes, seeded randomness and actions applied in sorted order, so a seed replays identically.

**Prior art?** Central drone delivery to clinics exists (for example Zipline), and so do swarm allocation, delay-tolerant networking and supply-chain tracking pilots; we found none that works offline between agents, hides contents and stock, and names the hop.

**Where's the map data from?** OpenStreetMap roads and villages, Copernicus DEM elevation, Sentinel-2 cloudless imagery by EOX.

## Sources (only these numbers)

- RUTF found stolen and sold in markets in north-east Nigeria: HumAngle; Daily Trust.
- Full cartons at resale sites most likely diverted from inside the health system, NGOs or UN agencies: MSF CRASH.
- 2023: USAID and WFP suspended food aid across Ethiopia over a diversion scheme, possibly the largest theft of food aid in history: PBS/AP; WFP statement.
- Jan 2022: ICRC cyber attack compromised data on more than 515,000 highly vulnerable people: ICRC.
