/**
 * Scenario overlay public types. Each scenario is the static trace of
 * one L2 capability unit at cluster-to-cluster granularity.
 */

import type { Edge, Node } from "@kepello/nodegraph-core";
import { SCENARIO_METADATA_KIND } from "./schema.js";

export interface SourceLocation {
  line: number;
  column?: number;
}

/**
 * One inter-cluster transition step in a scenario. Captures the call
 * site (source element, target element, source position) and projects
 * each end to its containing cluster + annotates with L1 stereotype +
 * L4 layer info when available.
 */
export interface TransitionStep {
  /** 0-based ordinal in the scenario's step list. */
  stepIndex: number;
  sourceCluster: string;
  targetCluster: string;
  /**
   * True when the call stayed INSIDE one cluster (`sourceCluster === targetCluster`).
   *
   * Fathom row `l5-intracluster-step-sparsity` (3.1.5.3). These steps used to be DISCARDED
   * — 83.6% of all closure call edges — which starved L7a's signature and was the root
   * cause of its confidence saturation. They are now emitted, and this marker keeps the
   * change OBSERVABLE rather than silent (no-silent-degradation): a consumer that genuinely
   * wants the old inter-cluster-only projection can still recover it by filtering on this
   * flag, instead of the projection being imposed on everyone.
   */
  intraCluster: boolean;
  /** L1 method stereotype of the caller; absent when L1 hasn't run. */
  sourceStereotype?: string;
  /** L1 method stereotype of the callee. */
  targetStereotype?: string;
  /** L4 layer number of the source cluster; absent when L4 hasn't run. */
  sourceLayer?: number;
  /** L4 layer number of the target cluster. */
  targetLayer?: number;
  /**
   * True when this step represents a dynamic-dispatch call site.
   * Always `false` in v1 because the wire protocol doesn't yet
   * surface dispatch kind — see Fathom Parked row
   * `l2-virtual-dispatch-protocol-extension` (3.1.2.1).
   */
  isBranching: boolean;
  /**
   * For direct calls: just the resolved target. For branching calls
   * (once supported): every candidate dispatch target.
   */
  candidateTargetIds: readonly string[];
  /** Caller element id. */
  sourceElementId: string;
  /** Primary callee element id (or representative candidate). */
  targetElementId: string;
  /**
   * Where in the source element's body the call appears. Used for
   * step ordering. Optional because the wire protocol marks
   * `AnalyzerEdge.sourceLocation` as optional on structural edges.
   */
  sourceLocation?: SourceLocation;
}

export interface ScenarioMetadata {
  kind: typeof SCENARIO_METADATA_KIND;
  scenarioId: string;
  capabilityUnitId: string;
  entryElementId: string;
  entryName: string;
  language?: string;
  stepCount: number;
  branchingPointCount: number;
  steps: readonly TransitionStep[];
  /** Distinct clusters in the order they're first touched. */
  traversedClusters: readonly string[];
}

export interface ScenarioInput {
  scenarioId: string;
  capabilityUnitId: string;
  entryElementId: string;
  entryName: string;
  language?: string;
  contentHash: string;
  steps: readonly TransitionStep[];
  traversedClusters: readonly string[];
}

export interface ScenarioNode extends Omit<Node, "metadata"> {
  metadata: ScenarioMetadata;
}

export interface ScenarioOverlay {
  insertScenario(input: ScenarioInput): ScenarioNode;
  tombstoneScenario(scenarioId: string): void;
  listScenarios(): ScenarioNode[];
  getScenario(scenarioId: string): ScenarioNode | undefined;
  scenarioForUnit(capabilityUnitId: string): ScenarioNode | undefined;
  /**
   * Outgoing `analysis-disposition` edge, kind `realizes` — exactly one
   * per scenario. Fathom row 3.1.8.4 wave 4: this IS the membership
   * record now (the legacy plain `realizes` edge type retired).
   */
  realizesEdge(scenarioId: string): Edge | undefined;
  /**
   * Outgoing `analysis-disposition` edges, kind `traverses` — one per
   * distinct cluster touched. Fathom row 3.1.8.4 wave 4: this IS the
   * membership record now (the legacy plain `traverses` edge type,
   * whose `subtype` carried the stepIndex, retired — step detail lives
   * solely in the scenario node's `metadata.steps`).
   */
  traversesEdges(scenarioId: string): Edge[];
}
