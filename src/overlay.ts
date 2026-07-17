/**
 * Scenario overlay implementation. Registers the `"scenario"` domain
 * idempotently at construction time. Writes:
 *
 *   - `realizes` edge — scenario → L2 capability unit (one per scenario).
 *   - `traverses` edges — scenario → cluster touched. Edge `subtype`
 *     carries the step-index (stringified) so consumers can recover
 *     order via `subtype` parsing without walking metadata.
 *
 * Step detail (source/target stereotype, layer, branching, source
 * location) lives in `metadata.steps`. Walking edges is the cheap path
 * for "which clusters does this scenario touch?"; walking metadata is
 * the path for full step inspection.
 *
 * Also emits `analysis-disposition` edges (Fathom row 3.1.8.4 wave 3a —
 * `@kepello/nodegraph-dispositions`'s `recordDispositions`, additive
 * alongside the membership edges above, per the design doc's §S3):
 *
 *   - `realizes` — scenario → L2 capability unit. ALWAYS `targetRef` in
 *     the `<domain>://<naturalKey>` cross-domain-URI form
 *     (`capability-unit://<unitId>`), independent of whether the unit
 *     node is materialized — unlike the membership `realizes` edge
 *     above, which resolves to `targetId` when it can. Design doc §S3:
 *     "always targetRef — unchanged" pins this as the STABLE disposition
 *     query surface even as L2 materialization timing varies.
 *   - `traverses` — scenario → cluster, one edge per DISTINCT cluster in
 *     `input.traversedClusters` (already deduplicated by the caller —
 *     see `ComputedScenario.traversedClusters`'s doc comment). Multiple
 *     steps landing in the same cluster still collapse to ONE
 *     disposition edge, exactly like the membership `traverses` edge
 *     does today; step-level detail (stepIndex, source/target element,
 *     stereotype, layer) is NEVER duplicated onto the disposition edge —
 *     it stays solely in the scenario node's `metadata.steps`.
 *
 * `capability-unit`'s domain string is a local literal, not imported
 * from `@kepello/nodegraph-capability-units` — this package has never
 * taken a runtime dependency on that sibling (see `UnitInput`'s doc
 * comment in `recovery.ts`: structural typing only), and a bare string
 * constant is the smallest change consistent with that.
 *
 * -----------------------------------------------------------------------
 * `realizes` targetRef pattern — query-time structured targets
 * -----------------------------------------------------------------------
 *
 * Each `realizes` edge points from a scenario node to its L2 capability
 * unit. When `ScenarioInput.capabilityUnitId` is NOT yet materialized as
 * a graph node (the common case — scenarios are often computed from a
 * cold analysis where L2 units are in a peer graph or haven't been
 * inserted yet), the edge is written as:
 *
 *   insertEdge({ sourceId, targetRef: capabilityUnitId, type: "realizes" })
 *
 * where `capabilityUnitId` is the L2 unit's NATURAL KEY — a pure-hex
 * content hash (e.g. `"bfe93b294554316c"`). This is the "query-time
 * structured target" pattern:
 *
 *   - `targetRef` = unit natural key (not a node id, not a cross-graph URI).
 *   - Resolution happens at QUERY TIME via `queryEdges({ targetRef: unitKey })`.
 *   - The substrate MUST NOT eagerly tail-resolve pure-hex `targetRef` values —
 *     hex strings are maximally ambiguous across domains, and tail-matching
 *     against a naturalKey index that spans all domains would silently produce
 *     wrong matches or false positives.
 *
 * Why not resolve eagerly?
 *   - L2 capability-unit natural keys are 16-hex-char content hashes with no
 *     domain prefix. Any eager "resolve this ref to a node" pass would need to
 *     scan every domain's naturalKey index, which is both expensive and wrong:
 *     the same hex string could plausibly appear as a natural key in an
 *     unrelated domain (file hash, commit hash, etc.).
 *   - The correct resolution path is: `queryEdges({ targetRef: unitKey,
 *     type: "realizes" })` or the overlay API `ScenarioOverlay.scenarioForUnit`.
 *
 * Consumers MUST use one of:
 *   1. `graph.queryEdges({ targetRef: capabilityUnitId, type: "realizes" })`
 *   2. `ScenarioOverlay.scenarioForUnit(capabilityUnitId)` — which implements (1).
 *   3. `ScenarioOverlay.realizesEdge(scenarioId)` — for the outgoing direction.
 *
 * Consumers MUST NOT treat a dangling `realizes` edge as data loss. The
 * `inspectDangling` tool classifies edges matching this pattern as
 * "query-time structured targets" and reports them separately from true
 * danglings — they are expected and indicate correct behavior.
 * -----------------------------------------------------------------------
 */

import type { Edge, GraphLayer, GraphMutator, Node } from "@kepello/nodegraph-core";
import {
  makeDispositionOverlay,
  type DispositionCandidate,
  type DispositionOverlay,
} from "@kepello/nodegraph-dispositions";
import {
  SCENARIO_DOMAIN,
  SCENARIO_INDEXES,
  SCENARIO_METADATA_KIND,
  SCENARIO_METADATA_SCHEMA,
  SCENARIO_SCHEMA_VERSION,
} from "./schema.js";
import {
  REALIZES_EDGE_TYPE,
  TRAVERSES_EDGE_TYPE,
  type ScenarioInput,
  type ScenarioMetadata,
  type ScenarioNode,
  type ScenarioOverlay,
} from "./types.js";

/** Local literal — see the module doc comment's "capability-unit's domain string" note. */
const CAPABILITY_UNIT_DOMAIN = "capability-unit";

export class ScenarioOverlayImpl implements ScenarioOverlay {
  private readonly mutator: GraphMutator<typeof SCENARIO_DOMAIN>;
  private readonly dispositionOverlay: DispositionOverlay;

  constructor(private readonly graph: GraphLayer) {
    // Per Fathom row 5.0.42: registerOverlay returns the domain-scoped mutator.
    this.mutator = this.graph.registerOverlay({
        domain: SCENARIO_DOMAIN,
        schemaVersion: SCENARIO_SCHEMA_VERSION,
        metadataSchema: SCENARIO_METADATA_SCHEMA,
        indexes: SCENARIO_INDEXES,
      });
    // Fathom row 3.1.8.4 wave 3a — `recordDispositions` edges are
    // sourced in THIS overlay's own `scenario` domain (never
    // `disposition`'s), so `this.mutator` above is what gets passed to
    // it; see `@kepello/nodegraph-dispositions`'s overlay.ts doc comment
    // for the `DomainMismatchError` constraint that forces this shape.
    this.dispositionOverlay = makeDispositionOverlay(this.graph);
  }

  insertScenario(input: ScenarioInput): ScenarioNode {
    return this.graph.transaction(
      {
        kind: "insert-scenario",
        producerDomain: SCENARIO_DOMAIN,
        summary: `insert scenario ${input.scenarioId}`,
      },
      () => this.doInsertScenario(input),
    ).result;
  }

  private doInsertScenario(input: ScenarioInput): ScenarioNode {
    const metadata = buildMetadata(input);
    const existing = this.graph.getLiveNodeByNaturalKey(
      SCENARIO_DOMAIN,
      input.scenarioId,
    );
    let node: Node;
    if (existing === undefined) {
      node = this.mutator.insertNode({
        domain: SCENARIO_DOMAIN,
        naturalKey: input.scenarioId,
        contentHash: input.contentHash,
        metadata: metadata as unknown,
      });
    } else if (existing.contentHash === input.contentHash) {
      node = existing;
    } else {
      node = this.mutator.supersedeNode(existing.id, {
        contentHash: input.contentHash,
        metadata: metadata as unknown,
      });
    }

    // realizes edge — exactly one. Tombstone any stragglers.
    const existingRealizes = this.graph.edgesFrom(node.id, {
      type: REALIZES_EDGE_TYPE,
      includeDangling: true,
    });
    let hasCorrectRealizes = false;
    for (const e of existingRealizes) {
      const matches =
        e.targetId === input.capabilityUnitId ||
        e.targetRef === input.capabilityUnitId;
      if (matches) hasCorrectRealizes = true;
      else this.mutator.tombstoneEdge(e.id);
    }
    if (!hasCorrectRealizes) {
      const byId = this.graph.getNodeById(input.capabilityUnitId);
      if (byId !== undefined) {
        this.mutator.insertEdge({
          sourceId: node.id,
          targetId: input.capabilityUnitId,
          type: REALIZES_EDGE_TYPE,
        });
      } else {
        this.mutator.insertEdge({
          sourceId: node.id,
          targetRef: input.capabilityUnitId,
          type: REALIZES_EDGE_TYPE,
        });
      }
    }

    // traverses edges — one per distinct cluster in first-seen order.
    // We deduplicate against existing edges (by target identity) rather
    // than tombstoning + re-emitting; substrate's live-unique index
    // collapses duplicate (source, target, type) triples for us.
    const existingTraverses = this.graph.edgesFrom(node.id, {
      type: TRAVERSES_EDGE_TYPE,
      includeDangling: true,
    });
    const existingTargets = new Set<string>();
    for (const e of existingTraverses) {
      if (e.targetId !== null) existingTargets.add(e.targetId);
      if (e.targetRef !== null) existingTargets.add(e.targetRef);
    }
    input.traversedClusters.forEach((clusterId, index) => {
      if (existingTargets.has(clusterId)) return;
      const byId = this.graph.getNodeById(clusterId);
      if (byId !== undefined) {
        this.mutator.insertEdge({
          sourceId: node.id,
          targetId: clusterId,
          type: TRAVERSES_EDGE_TYPE,
          subtype: String(index),
        });
      } else {
        this.mutator.insertEdge({
          sourceId: node.id,
          targetRef: clusterId,
          type: TRAVERSES_EDGE_TYPE,
          subtype: String(index),
        });
      }
    });

    // Fathom row 3.1.8.4 wave 3a — additive `analysis-disposition` edges,
    // alongside the membership edges above (module doc comment). ONE
    // candidate per distinct target; `recordDispositions` itself
    // collapses repeats within/across calls to one edge per
    // (source, target) pair.
    //
    // `input.capabilityUnitId` may be EITHER the unit's natural key
    // (content hash — the common cold-analysis case) OR an already-
    // resolved node id (mirrors the membership realizes edge's own
    // `byId` branch above). The disposition edge's `domain://naturalKey`
    // form always needs the REAL natural key — resolve through the node
    // when `capabilityUnitId` turns out to be an id, else it already IS
    // the natural key.
    const capabilityUnitById = this.graph.getNodeById(input.capabilityUnitId);
    const capabilityUnitNaturalKey =
      capabilityUnitById !== undefined ? capabilityUnitById.naturalKey : input.capabilityUnitId;
    const dispositionCandidates: DispositionCandidate[] = [
      {
        sourceId: node.id,
        // ALWAYS the cross-domain URI form — independent of the
        // membership realizes edge's resolvability above. See the
        // module doc comment.
        targetRef: `${CAPABILITY_UNIT_DOMAIN}://${capabilityUnitNaturalKey}`,
        kind: "realizes",
      },
      ...input.traversedClusters.map((clusterId): DispositionCandidate => {
        const byId = this.graph.getNodeById(clusterId);
        return byId !== undefined
          ? { sourceId: node.id, targetId: clusterId, kind: "traverses" }
          : { sourceId: node.id, targetRef: clusterId, kind: "traverses" };
      }),
    ];
    this.dispositionOverlay.recordDispositions(this.mutator, dispositionCandidates);

    return asScenario(node);
  }

  tombstoneScenario(scenarioId: string): void {
    this.graph.transaction(
      {
        kind: "tombstone-scenario",
        producerDomain: SCENARIO_DOMAIN,
        summary: `tombstone scenario ${scenarioId}`,
      },
      () => {
        const existing = this.graph.getLiveNodeByNaturalKey(
          SCENARIO_DOMAIN,
          scenarioId,
        );
        if (existing === undefined) return;
        this.mutator.tombstoneNode(existing.id);
      },
    );
  }

  listScenarios(): ScenarioNode[] {
    return this.graph
      .queryNodes({ domain: SCENARIO_DOMAIN, lifecycleState: "live" })
      .map(asScenario);
  }

  getScenario(scenarioId: string): ScenarioNode | undefined {
    const node = this.graph.getLiveNodeByNaturalKey(SCENARIO_DOMAIN, scenarioId);
    return node === undefined ? undefined : asScenario(node);
  }

  scenarioForUnit(capabilityUnitId: string): ScenarioNode | undefined {
    // Walk incoming `realizes` edges — substrate filters to live by default.
    const edges = this.graph.edgesTo(capabilityUnitId, {
      type: REALIZES_EDGE_TYPE,
    });
    if (edges.length === 0) {
      const byRef = this.graph.queryEdges({
        targetRef: capabilityUnitId,
        type: REALIZES_EDGE_TYPE,
      });
      if (byRef.length === 0) return undefined;
      edges.push(...byRef);
    }
    for (const edge of edges) {
      const node = this.graph.getNodeById(edge.sourceId);
      if (
        node !== undefined &&
        node.lifecycleState === "live" &&
        node.domain === SCENARIO_DOMAIN
      ) {
        return asScenario(node);
      }
    }
    return undefined;
  }

  realizesEdge(scenarioId: string): Edge | undefined {
    const node = this.graph.getLiveNodeByNaturalKey(SCENARIO_DOMAIN, scenarioId);
    if (node === undefined) return undefined;
    const edges = this.graph.edgesFrom(node.id, {
      type: REALIZES_EDGE_TYPE,
      includeDangling: true,
    });
    return edges[0];
  }

  traversesEdges(scenarioId: string): Edge[] {
    const node = this.graph.getLiveNodeByNaturalKey(SCENARIO_DOMAIN, scenarioId);
    if (node === undefined) return [];
    return this.graph.edgesFrom(node.id, {
      type: TRAVERSES_EDGE_TYPE,
      includeDangling: true,
    });
  }
}

function buildMetadata(input: ScenarioInput): ScenarioMetadata {
  let branchingPointCount = 0;
  for (const step of input.steps) {
    if (step.isBranching) branchingPointCount += 1;
  }
  const meta: ScenarioMetadata = {
    kind: SCENARIO_METADATA_KIND,
    scenarioId: input.scenarioId,
    capabilityUnitId: input.capabilityUnitId,
    entryElementId: input.entryElementId,
    entryName: input.entryName,
    stepCount: input.steps.length,
    branchingPointCount,
    steps: [...input.steps],
    traversedClusters: [...input.traversedClusters],
  };
  if (input.language !== undefined) meta.language = input.language;
  return meta;
}

function asScenario(node: Node): ScenarioNode {
  return node as ScenarioNode;
}

export function makeScenarioOverlay(graph: GraphLayer): ScenarioOverlay {
  return new ScenarioOverlayImpl(graph);
}
