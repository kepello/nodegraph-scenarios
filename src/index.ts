/**
 * Public API surface for `@kepello/nodegraph-scenarios`.
 */

// Schema
export {
  SCENARIO_DOMAIN,
  SCENARIO_INDEXES,
  SCENARIO_METADATA_KIND,
  SCENARIO_METADATA_SCHEMA,
  SCENARIO_SCHEMA_VERSION,
} from "./schema.js";

// Types
export {
  type ScenarioInput,
  type ScenarioMetadata,
  type ScenarioNode,
  type ScenarioOverlay,
  type SourceLocation,
  type TransitionStep,
} from "./types.js";

// Identity
export { computeScenarioId } from "./identity.js";

// Recovery algorithm
export {
  computeScenarios,
  type CallEdge,
  type ComputeScenariosInput,
  type ComputeScenariosResult,
  type ComputedScenario,
  type ScenarioRefusal,
  type ScenarioRefusalReason,
  type UnitInput,
} from "./recovery.js";

// Overlay
export {
  ScenarioOverlayImpl,
  makeScenarioOverlay,
} from "./overlay.js";
