/**
 * Scenario-recovery algorithm. For each L2 capability unit, walks the
 * closure's call edges in lexical source-position order, projects each
 * call to its source / target cluster, and emits one TransitionStep
 * per inter-cluster boundary. Intra-cluster sequences collapse to
 * nothing — the scenario only surfaces structural transitions.
 *
 * Pure function — no substrate IO. Inputs are plain data shapes the
 * consumer assembles from L2 capability units + L3 cluster assignments
 * + L0 call edges (with source position) + optional L1 stereotypes +
 * optional L4 layer numbers.
 */

import { computeScenarioId } from "./identity.js";
import type { SourceLocation, TransitionStep } from "./types.js";

/**
 * One L2 capability unit, in the minimal shape this algorithm needs.
 * Matches the public `ComputedUnit` shape from
 * `@kepello/nodegraph-capability-units`; consumers pass either the
 * computed result or a synthetic equivalent.
 */
export interface UnitInput {
  unitId: string;
  entryElementId: string;
  entryName: string;
  /** The closure's content hash — feeds `scenarioId` computation. */
  contentHash: string;
  /** Owned closure members; excludes entry. */
  ownedElementIds: readonly string[];
  /** Shared elements the closure references; excludes owned. */
  usedElementIds: readonly string[];
  language?: string;
}

/**
 * One directed call edge with source position info. `sourceLine` /
 * `sourceColumn` mirror the wire-protocol `AnalyzerEdge.sourceLocation`
 * shape. Missing positions sort to the end of the unit's step list.
 */
export interface CallEdge {
  source: string;
  target: string;
  sourceLine?: number;
  sourceColumn?: number;
}

export interface ComputeScenariosInput {
  units: readonly UnitInput[];
  callEdges: readonly CallEdge[];
  /**
   * Element id → containing cluster id. Built by the consumer from the
   * L3 cluster overlay (typically by walking each cluster's `groups`
   * member edges).
   */
  clusterByElement: ReadonlyMap<string, string>;
  /** L1 method-stereotype labels by element id (optional). */
  stereotypeByElement?: ReadonlyMap<string, string>;
  /** L4 layer number per cluster (optional). */
  layerByCluster?: ReadonlyMap<string, number>;
}

export interface ComputedScenario {
  scenarioId: string;
  capabilityUnitId: string;
  entryElementId: string;
  entryName: string;
  language?: string;
  steps: readonly TransitionStep[];
  /** Distinct clusters in step-order; first appearance wins. */
  traversedClusters: readonly string[];
  /** Content hash that fed `scenarioId`; useful for substrate writes. */
  contentHash: string;
}

export interface ComputeScenariosResult {
  scenarios: readonly ComputedScenario[];
}

export function computeScenarios(
  input: ComputeScenariosInput,
): ComputeScenariosResult {
  // Group call edges by source element for fast per-unit lookup.
  const edgesBySource = new Map<string, CallEdge[]>();
  for (const edge of input.callEdges) {
    let list = edgesBySource.get(edge.source);
    if (list === undefined) {
      list = [];
      edgesBySource.set(edge.source, list);
    }
    list.push(edge);
  }

  const scenarios: ComputedScenario[] = [];
  for (const unit of input.units) {
    // Closure = entry + owned. The unit's `usedElementIds` are call
    // targets, not sources we walk. Sources we walk = entry + owned.
    const walkSources = new Set<string>([
      unit.entryElementId,
      ...unit.ownedElementIds,
    ]);

    // Collect every call edge whose source is in the walk set.
    const closureEdges: CallEdge[] = [];
    for (const source of walkSources) {
      const edges = edgesBySource.get(source);
      if (edges !== undefined) closureEdges.push(...edges);
    }

    // Sort by lexical source position. Edges without a sourceLine
    // sort to the end (preserved among themselves in input order).
    closureEdges.sort(compareByLocation);

    // Project each edge to a cluster-pair; emit step when crossing.
    const steps: TransitionStep[] = [];
    const traversedClusters: string[] = [];
    const seenClusters = new Set<string>();
    for (const edge of closureEdges) {
      const srcCluster = input.clusterByElement.get(edge.source);
      const tgtCluster = input.clusterByElement.get(edge.target);
      if (srcCluster === undefined || tgtCluster === undefined) continue;
      if (srcCluster === tgtCluster) continue; // intra-cluster, skip

      const step: TransitionStep = {
        stepIndex: steps.length,
        sourceCluster: srcCluster,
        targetCluster: tgtCluster,
        sourceStereotype: input.stereotypeByElement?.get(edge.source),
        targetStereotype: input.stereotypeByElement?.get(edge.target),
        sourceLayer: input.layerByCluster?.get(srcCluster),
        targetLayer: input.layerByCluster?.get(tgtCluster),
        isBranching: false,
        candidateTargetIds: [edge.target],
        sourceElementId: edge.source,
        targetElementId: edge.target,
        sourceLocation:
          edge.sourceLine !== undefined
            ? buildLocation(edge.sourceLine, edge.sourceColumn)
            : undefined,
      };
      steps.push(step);

      // Append clusters in first-seen order.
      if (!seenClusters.has(srcCluster)) {
        seenClusters.add(srcCluster);
        traversedClusters.push(srcCluster);
      }
      if (!seenClusters.has(tgtCluster)) {
        seenClusters.add(tgtCluster);
        traversedClusters.push(tgtCluster);
      }
    }

    const scenarioId = computeScenarioId(unit.unitId, unit.contentHash);
    const contentHash = `${unit.unitId}\n${unit.contentHash}`;

    scenarios.push({
      scenarioId,
      capabilityUnitId: unit.unitId,
      entryElementId: unit.entryElementId,
      entryName: unit.entryName,
      language: unit.language,
      steps,
      traversedClusters,
      contentHash,
    });
  }

  // Deterministic scenario order: by entryElementId ascending.
  scenarios.sort((a, b) => a.entryElementId.localeCompare(b.entryElementId));

  return { scenarios };
}

function compareByLocation(a: CallEdge, b: CallEdge): number {
  // Edges with no sourceLine sort last; among those, preserve input order
  // (return 0). This keeps the algorithm stable for callers that emit
  // structural edges (no sourceLocation) interleaved with call edges.
  if (a.sourceLine === undefined && b.sourceLine === undefined) return 0;
  if (a.sourceLine === undefined) return 1;
  if (b.sourceLine === undefined) return -1;
  if (a.sourceLine !== b.sourceLine) return a.sourceLine - b.sourceLine;
  const ac = a.sourceColumn ?? 0;
  const bc = b.sourceColumn ?? 0;
  return ac - bc;
}

function buildLocation(line: number, column?: number): SourceLocation {
  return column === undefined ? { line } : { line, column };
}
