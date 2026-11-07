# Swarm integration notes (src/agents/swarm.ts)

Everything in `swarm.ts` is pure: same inputs, same outputs, nothing mutated, no `src/sim` import. Each carrier calls it with what it alone knows (its `AgentView` plus the beacons it heard) and logs the `reasons` strings. Log a reason only when its text differs from the last one you logged for that topic, or the inspector fills with repeats.

## 1. Contract asks for the lead (all optional fields, nothing breaks without them)

| Ask | Why |
|---|---|
| `Beacon.swarm?: SwarmBeacon` (type exported from swarm.ts) | carries bids, timestamps, role, vel/alt, relay post, patrol claim, clinic visits, towers-down flag. Works today without the change: `Msg.body` is `unknown`, so carrier.ts can spread `swarm` into the beacon the same way it already adds `cert` and `battery`. |
| `Beacon.holding[i].size?: SizeClass` | bidders need box size for capacity. Without it the swarm assumes `M` (2 units), so a drone may bid on an `L` box it can't lift; the holder's capacity check still refuses it. Size is already on the label carriers can read. |
| `Beacon.battery?: number` | carrier.ts already sends it; just make it official. |
| New action `{ type: 'status'; role?: string; phase?: NodeState['phase']; alt?: number }`, engine copies it into `NodeState` | there is no way today for an agent to set `role`/`phase`/`alt`, so the renderer can't show relays or altitude layers. Fallback if you'd rather not add an action: the engine reads `role`/`phase`/`alt` from the `swarm` field of the beacon that node sent this tick. |
| (optional) engine drains battery while a relay hovers | today hovering costs nothing, so relays never come home. |

## 2. Per-tick call order in carrier.ts (pseudo-code)

```ts
// new state next to the existing Maps
let auction = emptyAuction(); let patrol = emptyPatrol(); let net: NetObservation | null = null;
let relaySlot: string | null = null; let prevLeader: NodeId | null = null; let alt = 0; let vel = {x:0,y:0};
const clinics = new Map<NodeId, Vec2>();                     // clinics are public: cache them when met
const fresh: Peer[] = [];                                    // beacons received THIS tick (for gossip)

tick(v):
  ...existing checkHold + message loop...
  // in onMsg 'beacon': after trustedBeacon, also
  //   const p = peerFromBeacon(m.body, v.t, v.neighbours.find(n => n.id === m.from)?.pos); if (p) fresh.push(p)
  for (n of v.neighbours) if (n.kind === 'clinic') clinics.set(n.id, n.pos)
  const peers = [...beacons].map(([id,{b,t}]) => peerFromBeacon(b, t, liveNeighbourPos(id))).filter(Boolean)
              .concat([...clinics].map(([id,pos]) => ({ id, kind: 'clinic', pos, heardAt: v.t })))

  // 0. towers up or down (first-hand inside town coverage, otherwise from beacons)
  const ns = netStatus({ me: s.id, pos, cellSignal: v.cellSignal, now: v.t, peers, prev: net }); net = ns.obs; log(ns.reasons)

  // 1. auction: every carrier runs it; vans listen only (bidding: false)
  const tasks = [...boxTasks(peers, v.t, v.map, s.id), ...ownTasks({id:s.id, kind, pos}, heldLabels, v.map)]
  const a = auctionStep(auction, { me: { id: s.id, kind, pos, battery, spare: spare() }, now: v.t, tasks,
              gossip: fresh.map(gossipFromPeer).filter(Boolean), map: v.map,
              trusted: id => !blocked.has(id), bidding: kind !== 'van',
              engaged: [...deals.values()].map(d => taskId(d.packageId, d.role === 'take' ? d.partner : s.id)) })
  auction = a.state; log(a.reasons); fresh.length = 0

  // 2. as HOLDER, inside plan(): prefer the auction winner over scanning every beacon
  const w = auctionWinner(auction, taskId(l.packageId, s.id))
  if (w && beacons.has(w.bid.bidder) && winner has spare >= units(l)) {
      meet = chooseMeetPoint(me, winnerParty, v.map, s.rng, knownStores); if (meet) propose to w.bid.bidder, log(w.reason)
  } else fall back to decideHandoff(...) as today
  // as BIDDER: do nothing extra. Settled wins (a.wins[i].settled) just mean "expect an offer from this holder";
  // do not fly toward the holder yourself (vans may be at a store; drones must never learn where stores are).

  // 3. drones only, in this order: battery, relay, then flight
  if (kind === 'drone') {
    const ch = chargeDecision({ me: { pos, battery, carrying: held.map(l => ({ destCell, dest: cellCenter, urgency })) }, hubs })
    log(ch.reasons)                                           // 'return' overrides everything below
    const rp = planRelays({ me: { id: s.id, kind, pos, battery, carrying: heldLabels, busy: a.wins.length > 0 || deals.size > 0
              || ch.action === 'return', relaySlot }, now: v.t, networkDown: ns.down, peers, hubs, cellOf: v.map.cellOf })
    if (rp.mine?.id !== relaySlot) log(rp.reasons); relaySlot = rp.mine?.id ?? null
    goal = ch.action === 'return' ? ch.target : rp.mine ? rp.mine.pos : target(v)     // existing target()
    if (dist(pos, goal) > SWARM.ARRIVE_DIST && moving) {
      const f = carrying ? formation({ me: { id, pos, destCell, urgency }, dest: cellCenter(destCell), peers, now: v.t, prevLeader })
                         : null
      prevLeader = f?.leader ?? null
      const others = v.neighbours.filter(n => n.kind === 'drone').map(n => ({ id: n.id, pos: n.pos,
                      vel: peer(n.id)?.swarm?.vel ?? {x:0,y:0}, alt: peer(n.id)?.swarm?.alt ?? SWARM.ALT_EAST }))
      const sep = separate({ me: { id, pos, vel, alt }, desired: f?.desired ?? toward(pos, goal, SPEED.drone, v.dt), others, cellOf })
      vel = sep.vel; alt = stepAlt(alt, sep.alt, v.dt)
      out.push({ type: 'moveTo', path: steerPath(pos, vel, v.dt, goal) }); route = null   // bypass move()'s route cache
    } else if (rp.mine) { alt = stepAlt(alt, rp.alt!, v.dt) }  // hover at the post
  }

  // 4. idle motorbikes and boats: patrol instead of the fixed loop
  if ((kind === 'motorbike' || kind === 'boat') && !held.size && !deals.size && !a.wins.length) {
    const sites = [...clinics].map(([id,pos]) => ({id,pos})) + home hub + s.patrol waypoints as `wp-<n>`
    const pr = patrolStep(patrol, { me: { id: s.id, kind, pos }, now: v.t, sites, peers, map: v.map })
    patrol = pr.state; log(pr.reasons); if (pr.target) goal = pr.target   // else keep idleTarget()
  }

  // 5. beacon (build it AFTER auctionStep so bid stamps match the beacon time)
  beacon.swarm = swarmBeacon({ auction: a, role: swarmRole({ relay: !!relaySlot, charging: ch?.action === 'charge',
                  carrying: held.size, wins: a.wins.length, patrolling: !!patrol.claim }),
                  dest: primaryDest(holding), vel, alt, relaySlot, patrol: pr, net })
  beacon.holding[i].size = label.size
  out.push({ type: 'status', role, phase: flightPhase({ role, moving, distToGoal, alt, cruiseAlt: sep?.alt ?? 110 }), alt })
```

Cost: no crypto anywhere in swarm.ts; the heaviest call (`planRelays`) is O(nodes²) on ~35 nodes. Fine every tick.

## 3. How each piece works (one line each, for the pitch)

- **Auction (CBBA-style).** Bid = urgency weight × 600 / (600 + ETA to pick up and deliver), minus 0.3 × how full my hold is. Each carrier gossips its winner table plus a "last heard from" time per node in its beacon. Every node keeps, per box, the highest live bid (ties go to the lower NodeId), so everyone who heard the same beacons picks the same winner. A challenger must beat the standing winner by 0.02, and a winner keeps its bid frozen, so two drones don't trade a box back and forth. A winner silent for 12 s (6 beacon rounds, enough for a 6-hop relay chain) loses it and the box is re-auctioned. A winner that gets no offer within 30 s withdraws. A bid only counts if it beats the holder's own ETA by 20%, the same rule as today's hand-off. Request envelopes are deliberately not auctioned: every mule should carry a copy, because redundancy is what gets requests through a partition.
- **Relays.** When the towers are down, each idle drone works out radio groups from the last known positions it has (relays left out, stores never included), then bridges groups cheapest-first (Kruskal over groups), placing 1 to 3 posts on the line between the two closest members. At most 3 relays in total. Only idle drones relay, so a drone with an urgent box is never taken. A drone already on a post keeps it; otherwise the nearest idle drone takes it. Because groups are computed with relays left out, the bridge stays put once it works.
- **Separation.** Altitude by direction of travel: heading anywhere from north round to south via east flies at 110 m; heading the other way flies at 130 m. Head-on traffic is therefore always 20 m apart. When two same-layer drones are on course to pass within 120 m in the next 10 s, the higher NodeId moves one 10 m sub-layer away (east down, west up). Anything still inside 120 m at the same height gets pushed sideways. Same-corridor drones blend headings, capped at a 15° turn.
- **Formation.** 2+ drones with boxes for the same cell within 1.5 km: the one closest to the cell leads, the others take slots (a line for two, a V for three or more). The leader eases to 80% speed if someone lags, unless it carries an urgent box. The formation breaks 500 m from the cell so each drone can land.
- **Patrol.** Idle bikes and boats go to the clinic with the oldest last visit they know, skipping clinics a neighbour has claimed (earlier claim wins, ties to the lower NodeId). Visit times gossip, so the whole fleet shares one picture of which clinics are overdue.
- **Charging.** A drone carrying a box goes on only if its battery covers the clinic, the trip back to the nearest hub and a 2 km reserve; otherwise it returns. Idle drones head home at 1.3 × (distance to hub + reserve) and charge at the hub to 90%.

## 4. What judges should see

- NETWORK DOWN: within a few seconds 1 to 3 idle drones lift off and hover between the cut-off groups (`role: 'relay'`, `phase: 'relay'`, 160 m). Radio links reappear across the gap. Inspector: "Network down: clinic-1, van-01 +2 and clinic-2, moto-04 are cut off (4.0 km gap). I'm the nearest idle drone: relay 1 of 1 at C3-10." NETWORK UP: "Towers are back up: leaving my relay post."
- A van parks at a hub with three boxes. Three different drones peel off, one per box, and nobody doubles up. Logs: "Bid 0.82 for p-17 (van-02's box to C12-7); drone-03 bid 0.77; I win." The van logs "Auction for p-17: drone-05 won with 0.82 (runner-up drone-03 0.77). Offering it the box."
- Click a drone mid-air and you see two altitude layers by direction, plus "Yielding to drone-02 near C9-11: same eastbound layer, closest pass 35 m in 6 s. Moving to 100 m."
- Two or three drones heading to the same clinic fly in a line or V behind a leader.
- Idle motorbikes fan out to different clinics instead of all riding the same loop.

## 5. Limits worth knowing (say these, don't hide them)

- Two groups that can't hear each other can still both serve one request. The auction only prevents double-chasing inside a group, which matches PLAN 1.
- Agents can't see dead zones, so a relay post can land inside one and do nothing. A fix: skip posts where a fresh peer that should be in range isn't a radio neighbour.
- Altitude is only drawn, the engine moves in 2D, so separation is real horizontally and for display vertically.
- With beacons unsigned, a fake carrier could push bids. With certs on, carrier.ts already drops its beacons (`trusted`), bids above the highest possible value are refused, and the holder still hands over only to a certified node.

Tests: `npx vitest run tests/swarm.test.ts` (19 tests: convergence on a ring, no double-acting in one group, re-auction after silence, forged and Sybil bids, 20% rule, relay bridge plus consensus plus no flapping plus budget, towers-down inference, 6-drone and 8-drone separation runs with zero violations, coverage, formation, charging, determinism and no input mutation).
