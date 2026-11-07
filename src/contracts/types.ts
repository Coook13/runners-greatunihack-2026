// FROZEN contract. Only the lead edits this file. Read PLAN.md before using it.
// Every agent codes against these types. If you need a change, stop and ask the lead.

// ---------- basics ----------
export type Vec2 = { x: number; y: number };          // metres, origin bottom-left, world WORLD_SIZE x WORLD_SIZE
export type NodeId = string;                            // 'drone-03', 'moto-01', 'van-02', 'boat-01', 'store-A', 'clinic-4', 'dispatch'
export type CellId = string;                            // 'C7-3' = column 7, row 3 (CELL_SIZE cells)
export type CarrierKind = 'drone' | 'motorbike' | 'van' | 'boat';
export type NodeKind = CarrierKind | 'store' | 'clinic' | 'dispatch';
export type Urgency = 1 | 2 | 3;                        // 3 = most urgent; only 3 levels on purpose
export type SizeClass = 'S' | 'M' | 'L';
export type Mode = 'mesh' | 'central';

// ---------- keys and certificates ----------
export interface Sealed { epk: string; iv: string; ct: string }   // base64: ephemeral ECDH pubkey, IV, AES-GCM ciphertext

export interface KeySet {                               // one node's keys. CryptoKey objects stay in memory, never serialised.
  sealPub: string;                                      // ECDH P-256 public key, base64 raw
  sealPriv: CryptoKey;
  signPub: string;                                      // ECDSA P-256 public key, base64 raw
  signPriv: CryptoKey;
}

export interface Cert {                                 // P1: who is allowed in the network (PLAN section 12)
  nodeId: NodeId;
  role: NodeKind;
  signPub: string;
  expires: number;                                      // sim seconds
  sigs: { authority: string; sig: string }[];           // valid with 2 of 3 authority signatures
}

// ---------- boxes, requests, receipts ----------
export interface Manifest {
  requestId: string;
  items: { code: string; qty: number }[];               // codes from CATALOGUE in config.ts
  declaredKg: number;
  beneficiaryNote: string;                              // counts only, e.g. "12 children 6-59 months, 3 new". Never names.
}

export interface Label {                                // the ONLY box info a carrier may read
  packageId: string;
  requestId: string;
  attempt: number;
  urgency: Urgency;
  size: SizeClass;
  cold: boolean;
  destCell: CellId;
  deadline: number;                                     // sim seconds
}

export interface SealedBox {
  label: Label;
  sealed: Sealed;                                       // Manifest sealed to the clinic's sealPub
  auditorCopy?: Sealed;                                 // P1: same Manifest sealed to the auditor
  packedBy: NodeId;                                     // store that packed it
  packSig: string;                                      // packer's signature over { label, sealed }
}

export interface Receipt {                              // signed custody record
  packageId: string;
  requestId: string;
  attempt: number;
  kind: 'pickup' | 'handoff' | 'delivered';
  from: NodeId;
  to: NodeId;                                           // the receiver; the receiver always signs
  t: number;
  seq: number;                                          // logical counter = position in the box's passport (no wall clocks)
  cell: CellId;                                         // coarse only, never an exact position
  measuredKg: number;                                   // weight the receiver measured on receipt
  coerced?: boolean;                                    // P2: signed with the duress PIN
  sigTo: string;                                        // receiver's signature over every field except sigTo/sigFrom
  sigFrom?: string;                                     // optional countersign by the giver when still in range
}

export interface CarriedBox {                            // what a node physically holds (engine truth)
  box: SealedBox;
  measuredKg: number;                                   // what this node's scale reads now; agents cannot fake it
  passport: Receipt[];                                  // custody receipts that travel with the box (cells only)
}

export interface RequestEnvelope {                      // clinic -> stores, carried by mules
  requestId: string;
  attempt: number;
  urgency: Urgency;
  size: SizeClass;
  cold: boolean;
  destCell: CellId;
  deadline: number;
  replyPub: string;                                     // clinic sealPub so the store can seal the box to it
  clinicId: NodeId;
  clinicSignPub: string;
  clinicCert?: Cert;                                    // P1
  sealed: Sealed;                                       // Manifest sealed to the store network sealPub
  createdAt: number;
  sig: string;                                          // clinic signs every field except sig
}

export type AlertKind =
  | 'weight-mismatch'      // receiver's scale disagrees with the passport's last weight
  | 'short-delivery'       // clinic found contents/weight below the sealed manifest
  | 'bad-signature'
  | 'no-cert'
  | 'replay'
  | 'position-jump'
  | 'coerced'
  | 'rate-limited'
  | 'demand-anomaly';

export interface Alert {
  t: number;
  kind: AlertKind;
  reportedBy: NodeId;
  packageId?: string;
  suspect?: NodeId;
  cell: CellId;
  kg?: number;
  text: string;                                         // one plain line for the UI
}

// ---------- messages ----------
export type MsgKind =
  | 'beacon' | 'request' | 'claim'
  | 'handoff-propose' | 'handoff-accept'
  | 'lastmile-call' | 'lastmile-reply'
  | 'receipts' | 'alert' | 'order';

export interface Msg {
  id: string;
  from: NodeId;
  to: NodeId | '*';
  kind: MsgKind;
  body: unknown;
  hops: number;
  t: number;
  nonce?: string;                                       // P1: replay protection
  sig?: string;                                         // P1: sender signs; unsigned or bad = dropped
}

export interface Beacon {
  id: NodeId;
  kind: CarrierKind;
  pos: Vec2;
  heading: CellId[];                                    // next 3 cells it plans to pass
  spareCapacity: number;                                // in capacity units (S=1, M=2, L=4)
  holding: (Pick<Label, 'packageId' | 'destCell' | 'urgency'> & { size?: SizeClass })[];
  swarm?: unknown;                                      // swarm gossip (auction table, visit times, net status): see src/agents/swarm.ts
}

// ---------- what an agent can see and do ----------
export interface Hub { id: string; pos: Vec2 }           // relay hubs: carriers meet near these. Known to carriers, never stores.

export interface MapQuery {                             // terrain, roads, water, hubs. Never node positions.
  cellOf(p: Vec2): CellId;
  cellCenter(c: CellId): Vec2;
  route(kind: CarrierKind, from: Vec2, to: Vec2): Vec2[];
  eta(kind: CarrierKind, from: Vec2, to: Vec2): number; // seconds
  passable(kind: CarrierKind, p: Vec2): boolean;        // roads for vans/motorbikes, water for boats, anywhere for drones
  hubs(): Hub[];
}

export interface AgentView {                            // everything an agent may know this tick
  self: NodeId;
  kind: NodeKind;
  t: number;
  dt: number;
  pos: Vec2;
  battery: number;                                      // 0..1, drones only, 1 for others
  inventory: CarriedBox[];
  inbox: Msg[];
  neighbours: { id: NodeId; kind: NodeKind; pos: Vec2; dist: number }[];  // radio-connected right now
  cellSignal: boolean;                                  // cell network reachable here right now
  mode: Mode;
  map: MapQuery;
}

export type Action =
  | { type: 'moveTo'; path: Vec2[] }
  | { type: 'stop' }
  | { type: 'send'; msg: Omit<Msg, 'id' | 't' | 'hops'> }
  | { type: 'transfer'; packageId: string; to: NodeId } // engine runs it only if both within TRANSFER_RADIUS and receiver has capacity; passport moves with the box
  | { type: 'stamp'; packageId: string; receipt: Receipt } // receiver appends its signed receipt to the box's passport
  | { type: 'spawnBox'; box: SealedBox; kg: number }    // stores only
  | { type: 'consume'; packageId: string }              // clinics only, on delivery
  | { type: 'alert'; alert: Alert }                     // surfaces in the UI immediately, labelled with the reporter
  | { type: 'log'; text: string }                       // one plain line, shown in the inspector
  | { type: 'status'; role?: string; phase?: NodeState['phase']; alt?: number }; // swarm display state, copied into NodeState

export interface BreachDump {                           // what an attacker gets by breaching this device
  nodeId: NodeId;
  readableLabels: Label[];
  knownLocations: { what: 'store' | 'clinic' | 'hub' | 'handoff'; pos: Vec2 }[];
  knownStockLevels: number;                             // how many stores' stock levels this device knows
  readableBeneficiaryNotes: string[];
  nextHop: NodeId | null;
}

export interface Agent {
  id: NodeId;
  kind: NodeKind;
  tick(view: AgentView): Promise<Action[]>;
  dump(): BreachDump;
  receipts(): Receipt[];                                // every receipt this node holds (its own + gossiped)
}

export interface AgentSetup {                           // built by sim/setup.ts, handed to a factory
  id: NodeId;
  kind: NodeKind;
  keys: KeySet;
  cert: Cert | null;                                    // null until P1 certs are wired
  storeSealPub: string;                                 // store network sealing key; clinics seal requests to it
  storeSealPriv?: CryptoKey;                            // stores only
  storeIds: NodeId[];                                   // stores only: the other stores, for claims
  auditorSealPub: string;
  authoritySignPubs: string[];                          // 3 authorities; certs need 2
  home: Vec2;                                           // start position; stores, clinics and dispatch never move
  hubId?: string;                                       // carriers: home relay hub
  patrol?: Vec2[];                                      // motorbikes/boats: loop of waypoints past the clinics they serve
  rng: () => number;                                    // seeded per agent; use this, never Math.random
}

export type AgentFactory = (setup: AgentSetup) => Agent;
export type Factories = Record<NodeKind, AgentFactory>;

// ---------- engine, snapshot, events ----------
export interface Metrics {
  t: number;
  requestsOpen: number;
  boxesTotal: number;
  deliveredIntact: number;
  deliveredShort: number;
  skimmed: number;
  stolen: number;
  lostBreakdown: number;
  inTransit: number;
  duplicates: number;                                   // boxes delivered beyond what a request asked for
  leaksPinpointed: number;                              // losses where an alert named the holder
  attacksBlocked: number;                               // P1: attack console events the system rejected
  reachPct: number;                                     // deliveredIntact / requests made, 0..100
  meanDeliverySec: number;
  carriersAlive: number;
  carriersTotal: number;
}

export interface WorldEvent {                           // scripted or clicked by a judge
  t?: number;                                           // omitted = apply on the next tick
  type: 'demand' | 'networkDown' | 'networkUp' | 'deadZone' | 'clearZone'
      | 'breakdown' | 'skim' | 'steal' | 'breach' | 'raid'
      // P1 attack console (PLAN section 12):
      | 'fakeCarrier' | 'fakeClinic' | 'replay' | 'tamper' | 'flood'
      | 'spoofGps' | 'collude' | 'packShort' | 'coerce' | 'stealKey';
  target?: NodeId;
  pos?: Vec2;
  radius?: number;
  kg?: number;
}

export interface NodeState {
  id: NodeId;
  kind: NodeKind;
  pos: Vec2;
  alive: boolean;
  boxes: string[];                                      // packageIds on board
  battery: number;
  cellSignal: boolean;
  fake?: boolean;                                       // attack-console intruder, drawn differently
  // Realism (optional; renderer falls back gracefully when absent):
  alt?: number;                                         // metres above ground (drones climb/cruise/descend)
  heading?: number;                                     // radians, 0 = east, counter-clockwise
  phase?: 'idle' | 'takeoff' | 'cruise' | 'landing' | 'handoff' | 'charging' | 'relay';
  role?: string;                                        // swarm role, e.g. 'courier' | 'relay' | 'scout'
}

export interface TrafficEvent {                         // one message hop, for drawing data moving across the mesh
  from: NodeId;
  to: NodeId;
  kind: MsgKind;
  t: number;
}

export interface ThreatEvent {                          // adversary activity, for drawing and the threat feed
  t: number;
  kind: 'skim' | 'steal' | 'raid' | 'breach' | 'intercept' | 'fakeNode' | 'jam';
  actor: string;                                        // e.g. 'insider:moto-04', 'bandits@C9-5', 'hacker'
  target?: NodeId;
  pos?: Vec2;
  outcome: 'succeeded' | 'blocked' | 'detected' | 'contained';
  text: string;                                         // one plain line
}

export interface ReportReceived {                       // an alert that physically reached the district office via the mesh
  alert: Alert;
  receivedAt: number;
  hops: number;
}

export interface Snapshot {
  t: number;
  mode: Mode;
  nodes: NodeState[];
  links: [NodeId, NodeId][];                            // radio links this tick
  cellNetworkUp: boolean;
  deadZones: { pos: Vec2; radius: number }[];
  hubs: Hub[];
  metrics: Metrics;
  newAlerts: Alert[];                                   // raised this tick
  newLogs: { id: NodeId; t: number; text: string }[];   // written this tick
  traffic?: TrafficEvent[];                             // message hops delivered this tick (optional)
  threats?: ThreatEvent[];                              // adversary activity this tick (optional)
  reports?: ReportReceived[];                           // alerts that reached the district office this tick (optional)
}

export interface EngineApi {
  readonly mode: Mode;
  readonly seed: number;
  step(): Promise<Snapshot>;                            // advance one tick of TICK_DT sim seconds
  apply(ev: WorldEvent): void;                          // queue a judge or scripted event
  inspect(id: NodeId): { kind: NodeKind; dump: BreachDump; logs: string[] } | null;
  ledgerInput(): { receipts: Receipt[]; dead: NodeId[]; alerts: Alert[]; signPubs: Record<NodeId, string> };
  trackHistory(): Record<NodeId, Vec2[]>;               // sampled positions, for raiders
  auditorSealPriv(): CryptoKey;                         // P1 auditor view
}

export type CreateEngine = (opts: { seed: number; mode: Mode; factories: Factories; warmupSec?: number }) => Promise<EngineApi>;

// ---------- ledger report (WP4 -> UI) ----------
export interface LeakFinding {
  packageId: string;
  kind: 'skim' | 'stolen' | 'short-at-clinic' | 'packed-short' | 'coerced';
  holder: NodeId;                                       // who held it when the loss happened (or the packer)
  cell: CellId;
  kgLost: number;
  t: number;
}

export interface LedgerReport {
  boxes: number;
  deliveredIntact: number;
  deliveredShort: number;
  skimmed: number;
  stolen: number;
  lostBreakdown: number;
  inTransit: number;
  duplicates: number;
  badSignatures: number;
  findings: LeakFinding[];
}

// ---------- renderer and UI surfaces (WP5, WP6 -> lead) ----------
export type Tool = 'select' | 'deadZone' | 'breakdown' | 'skim' | 'steal' | 'breach';

export interface RendererApi {
  update(s: Snapshot): void;                            // call every tick; interpolate between calls
  setTool(t: Tool): void;
  onSelect(cb: (id: NodeId | null) => void): void;
  onGroundClick(cb: (pos: Vec2, tool: Tool) => void): void;
  onNodeClick(cb: (id: NodeId, tool: Tool) => void): void;
  highlight(ids: NodeId[]): void;
  dispose(): void;
}

export interface UiHandlers {
  onEvent(ev: WorldEvent): void;
  onTool(t: Tool): void;
  onMode(m: Mode | 'split'): void;
  onSpeed(x: number): void;
  onReset(): void;
  onFindingClick(f: LeakFinding): void;
}

export interface UiApi {
  update(main: Snapshot, other?: Snapshot): void;       // other = the central run in split mode (drawn as a 2D minimap)
  showInspect(info: { id: NodeId; kind: NodeKind; dump: BreachDump; logs: string[] } | null): void;
  showBreach(mesh: BreachDump | null, central: BreachDump | null): void;
  showLedger(r: LedgerReport): void;
  showSweep(data: unknown): void;
  showAttackResult(line: string): void;
}
