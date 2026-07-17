/**
 * Scenario overlay implementation tests. Pins:
 *
 *   - registerOverlay is idempotent.
 *   - insertScenario persists metadata + realizes + traverses edges.
 *   - insertScenario is idempotent on identical content-hash.
 *   - insertScenario supersedes on different content-hash.
 *   - tombstoneScenario removes from listScenarios.
 *   - scenarioForUnit walks the realizes edge.
 *   - traverses edges carry stepIndex in `subtype`.
 *   - branchingPointCount counts steps where isBranching === true.
 *   - step `sourceLocation` round-trips through `insertScenario` (5.0.116).
 *   - insertScenario ADDITIVELY emits `analysis-disposition` edges (Fathom
 *     row 3.1.8.4 wave 3a): scenario→L2 unit (`realizes`, always
 *     targetRef in the `<domain>://<naturalKey>` cross-domain form) and
 *     scenario→cluster (`traverses`, one edge per distinct cluster even
 *     when multiple steps land in the same cluster — step detail stays
 *     in the scenario node's `metadata.steps`, never duplicated onto the
 *     disposition edge). Membership (`realizes`/`traverses`) edges keep
 *     emitting unchanged, alongside the new disposition edges.
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  GraphLayerImpl,
  type GraphLayer,
} from "@kepello/nodegraph-core";
import { InMemoryBackend } from "@kepello/nodegraph-core/in-memory";
import {
  ANALYSIS_DISPOSITION_EDGE_TYPE,
  makeDispositionOverlay,
} from "@kepello/nodegraph-dispositions";
import {
  SCENARIO_DOMAIN,
  SCENARIO_METADATA_KIND,
} from "./schema.js";
import {
  REALIZES_EDGE_TYPE,
  TRAVERSES_EDGE_TYPE,
  type TransitionStep,
} from "./types.js";
import {
  ScenarioOverlayImpl,
  makeScenarioOverlay,
} from "./overlay.js";

function makeGraph(): GraphLayer {
  return new GraphLayerImpl(new InMemoryBackend());
}

function makeStep(
  stepIndex: number,
  sourceCluster: string,
  targetCluster: string,
  overrides: Partial<TransitionStep> = {},
): TransitionStep {
  return {
    stepIndex,
    sourceCluster,
    targetCluster,
    isBranching: false,
    candidateTargetIds: [`tgt-${stepIndex}`],
    sourceElementId: `src-${stepIndex}`,
    targetElementId: `tgt-${stepIndex}`,
    ...overrides,
  };
}

test("registerOverlay — idempotent on repeated construction", () => {
  const graph = makeGraph();
  const overlay = makeScenarioOverlay(graph);
  assert.doesNotThrow(() => new ScenarioOverlayImpl(graph));
  assert.ok(overlay);
});

test("insertScenario — persists metadata + realizes + traverses edges", () => {
  const graph = makeGraph();
  const overlay = makeScenarioOverlay(graph);
  const node = overlay.insertScenario({
    scenarioId: "sid-1",
    capabilityUnitId: "uid-1",
    entryElementId: "createUser",
    entryName: "createUser",
    contentHash: "ch1",
    steps: [
      makeStep(0, "controllers", "domain"),
      makeStep(1, "domain", "data"),
    ],
    traversedClusters: ["controllers", "domain", "data"],
  });
  assert.equal(node.metadata.kind, SCENARIO_METADATA_KIND);
  assert.equal(node.metadata.scenarioId, "sid-1");
  assert.equal(node.metadata.stepCount, 2);
  assert.equal(node.metadata.branchingPointCount, 0);

  const realizes = overlay.realizesEdge("sid-1");
  assert.ok(realizes);
  assert.equal(realizes.type, REALIZES_EDGE_TYPE);

  const traverses = overlay.traversesEdges("sid-1");
  assert.equal(traverses.length, 3);
});

/**
 * Fathom row edge-source-position-provenance (5.0.116), leg 3 pin:
 * `buildMetadata` spreads `input.steps` verbatim into
 * `metadata.steps` — `sourceLocation` (populated once positions flow
 * through `computeScenarios`, leg 3 of fathom-cli) round-trips through
 * `insertScenario` unchanged. No fix required here; pinned so a future
 * `buildMetadata` refactor can't silently drop the field.
 */
test("insertScenario — step sourceLocation round-trips through metadata (5.0.116 leg 3)", () => {
  const graph = makeGraph();
  const overlay = makeScenarioOverlay(graph);
  const node = overlay.insertScenario({
    scenarioId: "sid-loc",
    capabilityUnitId: "uid-loc",
    entryElementId: "createUser",
    entryName: "createUser",
    contentHash: "ch-loc",
    steps: [
      makeStep(0, "controllers", "domain", { sourceLocation: { line: 10, column: 4 } }),
      makeStep(1, "domain", "data", { sourceLocation: { line: 30 } }),
    ],
    traversedClusters: ["controllers", "domain", "data"],
  });
  assert.deepEqual(node.metadata.steps[0].sourceLocation, { line: 10, column: 4 });
  assert.deepEqual(node.metadata.steps[1].sourceLocation, { line: 30 });

  const fetched = overlay.getScenario("sid-loc");
  assert.deepEqual(fetched?.metadata.steps[0].sourceLocation, { line: 10, column: 4 });
  assert.deepEqual(fetched?.metadata.steps[1].sourceLocation, { line: 30 });
});

test("insertScenario — idempotent on identical content-hash", () => {
  const graph = makeGraph();
  const overlay = makeScenarioOverlay(graph);
  const a = overlay.insertScenario({
    scenarioId: "s",
    capabilityUnitId: "u",
    entryElementId: "e",
    entryName: "e",
    contentHash: "h",
    steps: [],
    traversedClusters: ["c0"],
  });
  const b = overlay.insertScenario({
    scenarioId: "s",
    capabilityUnitId: "u",
    entryElementId: "e",
    entryName: "e",
    contentHash: "h",
    steps: [],
    traversedClusters: ["c0"],
  });
  assert.equal(a.id, b.id);
  // No duplicate traverses edges.
  assert.equal(overlay.traversesEdges("s").length, 1);
});

test("insertScenario — supersedes on different content-hash", () => {
  const graph = makeGraph();
  const overlay = makeScenarioOverlay(graph);
  const a = overlay.insertScenario({
    scenarioId: "s",
    capabilityUnitId: "u",
    entryElementId: "e",
    entryName: "e",
    contentHash: "v1",
    steps: [],
    traversedClusters: ["c0"],
  });
  const b = overlay.insertScenario({
    scenarioId: "s",
    capabilityUnitId: "u",
    entryElementId: "e",
    entryName: "e",
    contentHash: "v2",
    steps: [makeStep(0, "c0", "c1")],
    traversedClusters: ["c0", "c1"],
  });
  assert.notEqual(a.id, b.id);
  const live = overlay.listScenarios();
  assert.equal(live.length, 1);
  assert.equal(live[0].id, b.id);
  assert.equal(live[0].metadata.stepCount, 1);
});

test("tombstoneScenario — removes from listScenarios", () => {
  const graph = makeGraph();
  const overlay = makeScenarioOverlay(graph);
  overlay.insertScenario({
    scenarioId: "doomed",
    capabilityUnitId: "u",
    entryElementId: "e",
    entryName: "e",
    contentHash: "h",
    steps: [],
    traversedClusters: [],
  });
  assert.equal(overlay.listScenarios().length, 1);
  overlay.tombstoneScenario("doomed");
  assert.equal(overlay.listScenarios().length, 0);
});

test("tombstoneScenario — silent no-op on unknown id", () => {
  const graph = makeGraph();
  const overlay = makeScenarioOverlay(graph);
  assert.doesNotThrow(() => overlay.tombstoneScenario("missing"));
});

test("scenarioForUnit — walks the realizes edge", () => {
  const graph = makeGraph();
  const overlay = makeScenarioOverlay(graph);
  overlay.insertScenario({
    scenarioId: "s",
    capabilityUnitId: "myUnit",
    entryElementId: "e",
    entryName: "e",
    contentHash: "h",
    steps: [],
    traversedClusters: [],
  });
  const scenario = overlay.scenarioForUnit("myUnit");
  assert.ok(scenario);
  assert.equal(scenario.metadata.scenarioId, "s");
});

test("scenarioForUnit — undefined when no scenario realizes the unit", () => {
  const graph = makeGraph();
  const overlay = makeScenarioOverlay(graph);
  assert.equal(overlay.scenarioForUnit("nothing"), undefined);
});

test("traversesEdges — carry stepIndex in subtype", () => {
  const graph = makeGraph();
  const overlay = makeScenarioOverlay(graph);
  overlay.insertScenario({
    scenarioId: "s",
    capabilityUnitId: "u",
    entryElementId: "e",
    entryName: "e",
    contentHash: "h",
    steps: [makeStep(0, "c0", "c1")],
    traversedClusters: ["c0", "c1"],
  });
  const edges = overlay.traversesEdges("s");
  // Edges carry the ordinal index in subtype.
  const subtypes = edges.map((e) => e.subtype).sort();
  assert.deepEqual(subtypes, ["0", "1"]);
});

test("branchingPointCount — counts isBranching steps", () => {
  const graph = makeGraph();
  const overlay = makeScenarioOverlay(graph);
  const node = overlay.insertScenario({
    scenarioId: "s",
    capabilityUnitId: "u",
    entryElementId: "e",
    entryName: "e",
    contentHash: "h",
    steps: [
      makeStep(0, "c0", "c1", { isBranching: true }),
      makeStep(1, "c1", "c2"),
      makeStep(2, "c2", "c3", { isBranching: true }),
    ],
    traversedClusters: ["c0", "c1", "c2", "c3"],
  });
  assert.equal(node.metadata.branchingPointCount, 2);
});

test("SCENARIO_DOMAIN — domain identifier", () => {
  assert.equal(SCENARIO_DOMAIN, "scenario");
});

test("insertScenario — additively emits an analysis-disposition realizes edge, scenario→L2 unit, always targetRef in domain://naturalKey form", () => {
  const graph = makeGraph();
  const overlay = makeScenarioOverlay(graph);
  const node = overlay.insertScenario({
    scenarioId: "sid-disp-1",
    capabilityUnitId: "uid-disp-1",
    entryElementId: "createUser",
    entryName: "createUser",
    contentHash: "ch1",
    steps: [makeStep(0, "controllers", "domain")],
    traversedClusters: ["controllers", "domain"],
  });

  // The membership realizes edge is UNCHANGED (dangling — unit not materialized).
  const membershipRealizes = overlay.realizesEdge("sid-disp-1");
  assert.ok(membershipRealizes);
  assert.equal(membershipRealizes.type, REALIZES_EDGE_TYPE);

  const dispositionOverlay = makeDispositionOverlay(graph);
  const dispositions = dispositionOverlay.dispositionsOf(node.id);
  const realizesDisposition = dispositions.find((e) => e.subtype === "realizes");
  assert.ok(realizesDisposition, "expected an analysis-disposition edge with subtype realizes");
  assert.equal(realizesDisposition!.type, ANALYSIS_DISPOSITION_EDGE_TYPE);
  assert.equal(realizesDisposition!.targetId, null);
  // ALWAYS the cross-domain URI form — even though the L2 unit isn't
  // materialized here (so the membership edge above is bare targetRef
  // too); the disposition edge's form does not depend on resolvability.
  assert.equal(realizesDisposition!.targetRef, "capability-unit://uid-disp-1");
  assert.deepEqual((realizesDisposition!.metadata as { kinds: string[] }).kinds, ["realizes"]);
});

test("insertScenario — realizes disposition edge ALWAYS uses the domain-prefixed targetRef, even when the L2 unit node IS materialized", () => {
  const graph = makeGraph();
  const capabilityUnitMutator = graph.registerOverlay({
    domain: "capability-unit",
    schemaVersion: 1,
    metadataSchema: { type: "object", properties: {} },
    indexes: [],
  });
  const unitNode = graph.transaction(
    { kind: "insert-unit", producerDomain: "capability-unit", summary: "test fixture unit" },
    () =>
      capabilityUnitMutator.insertNode({
        domain: "capability-unit",
        naturalKey: "uid-disp-materialized",
        contentHash: "uch",
        metadata: {},
      }),
  ).result;

  const overlay = makeScenarioOverlay(graph);
  const node = overlay.insertScenario({
    scenarioId: "sid-disp-2",
    capabilityUnitId: unitNode.id,
    entryElementId: "createUser",
    entryName: "createUser",
    contentHash: "ch1",
    steps: [],
    traversedClusters: [],
  });

  // The MEMBERSHIP realizes edge resolves to the real node (targetId) —
  // existing behavior, unchanged.
  const membershipRealizes = overlay.realizesEdge("sid-disp-2");
  assert.equal(membershipRealizes?.targetId, unitNode.id);

  // The DISPOSITION realizes edge still uses targetRef in the
  // domain-prefixed natural-key form — per the design's "always
  // targetRef" ruling, independent of the membership edge's resolution.
  const dispositionOverlay = makeDispositionOverlay(graph);
  const realizesDisposition = dispositionOverlay
    .dispositionsOf(node.id)
    .find((e) => e.subtype === "realizes");
  assert.ok(realizesDisposition);
  assert.equal(realizesDisposition!.targetId, null);
  assert.equal(realizesDisposition!.targetRef, "capability-unit://uid-disp-materialized");
});

test("insertScenario — traverses disposition edges are ONE per distinct cluster, even when multiple steps land in the same cluster; step detail stays out of the edge", () => {
  const graph = makeGraph();
  const overlay = makeScenarioOverlay(graph);
  // Two DIFFERENT steps both target "domain" — the uniqueness index
  // already collapses the MEMBERSHIP traverses edge to one per cluster;
  // this asserts the disposition edge collapses identically (not
  // secretly one-per-step).
  const node = overlay.insertScenario({
    scenarioId: "sid-disp-3",
    capabilityUnitId: "uid-disp-3",
    entryElementId: "createUser",
    entryName: "createUser",
    contentHash: "ch1",
    steps: [
      makeStep(0, "controllers", "domain"),
      makeStep(1, "domain", "domain"), // both endpoints "domain" again
    ],
    traversedClusters: ["controllers", "domain"],
  });

  const membershipTraverses = overlay.traversesEdges("sid-disp-3");
  assert.equal(membershipTraverses.length, 2, "membership: one per distinct cluster, unchanged");

  const dispositionOverlay = makeDispositionOverlay(graph);
  const dispositions = dispositionOverlay.dispositionsOf(node.id);
  const traversesDispositions = dispositions.filter((e) => e.subtype === "traverses");
  assert.equal(
    traversesDispositions.length,
    2,
    "one analysis-disposition edge per DISTINCT cluster (controllers, domain) — not one per step",
  );
  // Step detail (stepIndex, sourceElementId, etc.) is NOT duplicated
  // onto the disposition edge — it stays on the scenario node's own
  // metadata.steps.
  for (const edge of traversesDispositions) {
    assert.equal((edge.metadata as Record<string, unknown>).steps, undefined);
    assert.equal((edge.metadata as Record<string, unknown>).stepIndex, undefined);
  }
  assert.equal(node.metadata.steps.length, 2, "full step detail lives on the scenario node");
});

test("insertScenario — disposition edges do not duplicate on idempotent re-insert (identical content-hash)", () => {
  const graph = makeGraph();
  const overlay = makeScenarioOverlay(graph);
  const input = {
    scenarioId: "sid-disp-4",
    capabilityUnitId: "uid-disp-4",
    entryElementId: "e",
    entryName: "e",
    contentHash: "h",
    steps: [makeStep(0, "c0", "c1")],
    traversedClusters: ["c0", "c1"],
  };
  const a = overlay.insertScenario(input);
  const b = overlay.insertScenario(input);
  assert.equal(a.id, b.id);

  const dispositionOverlay = makeDispositionOverlay(graph);
  const dispositions = dispositionOverlay.dispositionsOf(a.id);
  assert.equal(dispositions.filter((e) => e.subtype === "realizes").length, 1);
  assert.equal(dispositions.filter((e) => e.subtype === "traverses").length, 2);
});
