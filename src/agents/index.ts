// Mesh agents (WP2). Every node decides alone from its own AgentView: there is no central brain in mesh mode.
// This folder never imports from src/sim (tests/core.test.ts checks it).
import type { Agent, AgentFactory, AgentSetup, BreachDump, Factories } from '../contracts/types';
import { createCarrier } from './carrier';
import { createClinic } from './clinic';
import { createStore } from './store';

/** Dispatch only exists in central mode (PLAN 13 #17); in mesh mode it is never built. Kept as an idle node. */
const idle: AgentFactory = (s: AgentSetup): Agent => ({
  id: s.id,
  kind: s.kind,
  async tick() { return []; },
  dump(): BreachDump {
    return { nodeId: s.id, readableLabels: [], knownLocations: [], knownStockLevels: 0, readableBeneficiaryNotes: [], nextHop: null };
  },
  receipts() { return []; },
});

export const meshFactories: Factories = {
  drone: createCarrier,
  motorbike: createCarrier,
  van: createCarrier,
  boat: createCarrier,
  store: createStore,
  clinic: createClinic,
  dispatch: idle,
};

export { createCarrier, createClinic, createStore };
export type { ClinicAgent } from './clinic';
