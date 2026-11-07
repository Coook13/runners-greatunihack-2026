// Every line the auto-play demo puts on screen. Static lines are plain strings; lines that carry
// numbers from the live run are functions, so nothing on screen is written in advance (PLAN section 2).
// Writing rules: short enough to read from the back of a room, plain words, no em dashes.
// demo/script.md speaks to the same beats; demo/claims-to-proof.md maps each claim to its beat.
import type { Alert } from '../contracts/types';

/** Where each run sits on screen in split mode. Flip these if main.ts swaps the sides. */
export const LAYOUT = { today: 'Left', runners: 'Right' } as const;

const crates = (n: number) => `${n} crate${n === 1 ? '' : 's'}`;
const kgText = (kg: number | undefined) => (kg === undefined ? 'some weight' : `${Math.round(kg * 10) / 10} kg`);

export interface SideNumbers { delivered: number; named: number }

export const CAPTIONS = {
  hook: 'Runners. Keep supplies moving when central communications fail.',
  map: 'Hawassa, Ethiopia, on real roads and satellite imagery. The deliveries are simulated.',
  split: `${LAYOUT.today}: central dispatch. ${LAYOUT.runners}: independent agents. Same demand.`,
  single: 'Runners on the real roads of Hawassa. Every vehicle decides for itself.',

  // Today side
  clipboard: (van: string, stores: number) =>
    `Today, the paperwork on ${van} shows where each crate goes, and all ${stores} stores.`,
  theft: (kg: number) => `An insider takes ${kgText(kg)} from a crate. We run the same theft on both sides.`,
  todayBlind: 'Central dispatch has no signed hand-off history to identify the holder.',

  // Runners side
  blackBox: (id: string | null) =>
    id ? `Runners: the black box on ${id} tells the crew the next step. The crates stay sealed.`
      : 'Runners: each vehicle has a black box that tells the crew the next step. The crates stay sealed.',
  crew: 'The crew never writes down what is inside or who it is for.',
  handoffWait: 'At the next hand-off, the receiving vehicle weighs the crate.',
  caught: (a: Alert) =>
    `Caught at the next hand-off: crate ${a.packageId ?? '?'} is ${kgText(a.kg)} light. ${a.suspect ?? a.reportedBy} held it, in cell ${a.cell}.`,

  // Hacker
  breachToday: (stores: number, notes: number) =>
    `Central device: ${stores} store locations and ${notes} clinic notes exposed.`,
  breachRunners: (stores: number, notes: number) =>
    `Same last-mile device in Runners: ${stores} store locations and ${notes} clinic notes exposed.`,

  // Outage
  networkDown: 'Tower outage. The cell network is off on both sides.',
  swarm: (droneLinks: number) =>
    droneLinks > 0
      ? 'Local radio connects nearby agents. Vehicles carry messages across disconnected areas.'
      : 'Vehicles carry the messages themselves while the towers are down.',
  outage: (runners: number, today: number | null) =>
    today !== null && runners > today
      ? `Since the outage, Runners delivered ${crates(runners)} and today's dispatch delivered ${today}.`
      : today !== null
        ? "New requests can't reach today's dispatch. In Runners they ride on the vehicles."
        : runners > 0
          ? `Since the outage, Runners delivered ${crates(runners)} with no network.`
          : 'Requests now ride on the vehicles themselves.',
  networkUp: 'Network back. The receipts each vehicle carried merge into one ledger.',
  ledgerPending: 'Merging the ledgers.',
  ledger: (boxes: number, intact: number, named: number) =>
    `${crates(boxes)} on the merged ledger: ${intact} delivered intact, ${named} losses traced to a named hand-off.`,

  // Auditor
  glassBox: (pkg: string, hops: number, kg: number | undefined, holder: string) =>
    `Auditors get a glass box. Crate ${pkg}: ${hops} signed hand-offs, ${kgText(kg)} lost while ${holder} held it.`,
  glassBoxGeneric: "Auditors get a glass box: every crate's chain of custody, with the weight at each hand-off.",

  // Close
  score: (today: SideNumbers | null, runners: SideNumbers) =>
    today
      ? `Today: ${today.delivered} delivered intact, ${today.named} losses named. Runners: ${runners.delivered} delivered intact, ${runners.named} losses named.`
      : `Runners: ${runners.delivered} delivered intact, ${runners.named} losses named.`,
  close: 'Local decisions. Signed custody. Delivery through disconnection.',
  title: 'Runners. GreatUniHack 2026, Neptune North track.',
} as const;

/** Every caption that is a fixed string, for the writing-rules test. */
export const STATIC_CAPTIONS: string[] = (Object.values(CAPTIONS) as unknown[]).filter((c): c is string => typeof c === 'string');
