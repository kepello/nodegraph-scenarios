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
 * Ties (identical line+column, or both missing a position) break on
 * `targetKey` when supplied, else `target` (lexicographic) — see
 * `compareByLocation` (5.0.116 M2, reviewer F1 fix).
 */
export interface CallEdge {
  source: string;
  target: string;
  sourceLine?: number;
  sourceColumn?: number;
  /**
   * Rebuild-stable identifier for `target` — the target element's
   * natural key. `target` itself is a substrate node id, minted fresh
   * (random UUIDv4) on every insert; it is NOT stable across
   * independent rebuilds of the same source. `compareByLocation`'s
   * tiebreak prefers `targetKey` when supplied so tied steps sort
   * identically across rebuilds, not just across arrival orders of a
   * single run. Callers that omit `targetKey` fall back to `target` —
   * API-compatible, but determinism is guaranteed ONLY across a single
   * graph's lifetime (rebuild-to-rebuild stability requires
   * `targetKey`). Fathom row `edge-source-position-provenance`
   * (5.0.116), reviewer F1 fix: the 0.4.0 tiebreak keyed on `target`
   * alone, which is exactly the unstable identifier it was meant to
   * route around for every tie shape (including the both-missing-
   * position shape, which is EVERY .NET/Swift edge until position
   * parity lands).
   */
  targetKey?: string;
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

      // Fathom row `l5-intracluster-step-sparsity` (3.1.5.3): this used to be
      //     `if (srcCluster === tgtCluster) continue;  // intra-cluster, skip`
      // which discarded **83.6% of all closure call edges** (2,089 of 2,498 on the
      // Fathom corpus), projecting what survived onto just 45 cluster-pairs. Distinct
      // operations therefore handed L7a byte-identical step streams — the root cause of
      // L7a's confidence saturation, and the reason 1,090 of 1,220 scenarios had ZERO
      // steps (569 of them lost EVERY call to this line; only 490 were genuine leaves).
      //
      // The signal was always in the fact graph; L5 simply chose not to emit it. Its
      // gates passed honestly because they measured what L5 CHOSE to emit and never
      // whether that choice carried enough information for the layer above — precisely
      // the emission-vs-resolution completeness blind spot `baselines.md` warns about.
      //
      // Intra-cluster steps are now EMITTED and MARKED. The marker is not decoration:
      // it keeps the semantic change observable rather than silent, so a consumer can
      // still recover the old inter-cluster-only projection if it genuinely wants it.
      const intraCluster = srcCluster === tgtCluster;

      const step: TransitionStep = {
        stepIndex: steps.length,
        sourceCluster: srcCluster,
        targetCluster: tgtCluster,
        intraCluster,
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
  // Edges with no sourceLine sort last. Ties — either both missing a
  // position, or an identical line+column — break on `targetKey` when
  // supplied, else `target` (lexicographic). Fathom row
  // edge-source-position-provenance (5.0.116), M2 + reviewer F1 fix:
  // `input.callEdges` arrival order comes from the caller's backend
  // query, which issues no `ORDER BY` (row order is an implementation
  // accident, not a contract) — relying on it for a tie would make
  // step order unstable across rebuilds. The original M2 fix keyed the
  // tiebreak on `target` alone, but `target` is itself a substrate node
  // id minted fresh (random UUIDv4) per insert — NOT rebuild-stable —
  // so that tiebreak was only arrival-order-stable within a single
  // graph, not rebuild-stable across independent rebuilds. `targetKey`
  // (the target's natural key, rebuild-stable by construction) is the
  // tiebreak's actual determinism source when supplied; `target`
  // remains the fallback for callers that don't have one.
  if (a.sourceLine === undefined && b.sourceLine === undefined) {
    return tieKey(a).localeCompare(tieKey(b));
  }
  if (a.sourceLine === undefined) return 1;
  if (b.sourceLine === undefined) return -1;
  if (a.sourceLine !== b.sourceLine) return a.sourceLine - b.sourceLine;
  const ac = a.sourceColumn ?? 0;
  const bc = b.sourceColumn ?? 0;
  if (ac !== bc) return ac - bc;
  return tieKey(a).localeCompare(tieKey(b));
}

function tieKey(edge: CallEdge): string {
  return edge.targetKey ?? edge.target;
}

function buildLocation(line: number, column?: number): SourceLocation {
  return column === undefined ? { line } : { line, column };
}
