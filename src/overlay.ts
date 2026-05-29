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
 */

import type { Edge, GraphLayer, GraphMutator, Node } from "@kepello/nodegraph-core";
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

export class ScenarioOverlayImpl implements ScenarioOverlay {
  private readonly mutator: GraphMutator<typeof SCENARIO_DOMAIN>;

  constructor(private readonly graph: GraphLayer) {
    // Per Fathom row 5.0.42: registerOverlay returns the domain-scoped mutator.
    this.mutator = this.graph.registerOverlay({
        domain: SCENARIO_DOMAIN,
        schemaVersion: SCENARIO_SCHEMA_VERSION,
        metadataSchema: SCENARIO_METADATA_SCHEMA,
        indexes: SCENARIO_INDEXES,
      });
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
