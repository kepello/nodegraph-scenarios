/**
 * Scenario overlay implementation tests. Pins:
 *
 *   - registerOverlay is idempotent.
 *   - insertScenario persists metadata + `analysis-disposition` realizes +
 *     traverses edges (Fathom row 3.1.8.4 wave 4 — disposition edges ARE
 *     the membership record; the legacy `realizes`/`traverses` MEMBERSHIP
 *     edge TYPE family retired this wave, no dual-emission).
 *   - insertScenario is idempotent on identical content-hash.
 *   - insertScenario supersedes on different content-hash.
 *   - tombstoneScenario removes from listScenarios.
 *   - scenarioForUnit walks the realizes disposition edge, DANGLING and
 *     RESOLVED cases both (wave 4 KNOWN TRAP — the disposition `realizes`
 *     edge ALWAYS carries the domain-prefixed targetRef; the resolved
 *     case only arises when the unit node materializes AFTER the
 *     scenario's disposition edge already exists).
 *   - traversesEdges' `subtype` is the disposition kind ("traverses"),
 *     not a stepIndex — step detail lives solely in `metadata.steps`.
 *   - branchingPointCount counts steps where isBranching === true.
 *   - step `sourceLocation` round-trips through `insertScenario` (5.0.116).
 *   - DRIFT PARITY (wave 4): a changed capability unit / a departed
 *     cluster tombstones its stale disposition edge — the invariant that
 *     live disposition edges == current membership, always. The legacy
 *     membership `realizes` edge tombstoned a drifted target; wave 3a's
 *     ADDITIVE disposition edges did not — this closes that gap.
 *   - legacy membership edge TYPES (`realizes`/`traverses` as an edge
 *     `type`, not a disposition `subtype`) are NEVER emitted.
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
import { type TransitionStep } from "./types.js";
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

test("insertScenario — persists metadata + realizes + traverses disposition edges", () => {
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
  assert.equal(realizes!.type, ANALYSIS_DISPOSITION_EDGE_TYPE);
  assert.equal(realizes!.subtype, "realizes");
  assert.equal(realizes!.targetRef, "capability-unit://uid-1");

  const traverses = overlay.traversesEdges("sid-1");
  assert.equal(traverses.length, 3);
  for (const e of traverses) {
    assert.equal(e.type, ANALYSIS_DISPOSITION_EDGE_TYPE);
    assert.equal(e.subtype, "traverses");
  }
});

/**
 * Fathom row 3.1.8.4 wave 4 — direct RED-witness pin for the membership
 * retirement. On wave-3a code this fails: the plain `realizes`/
 * `traverses` EDGE TYPE (as distinct from the disposition edge's
 * `subtype`) was still emitted alongside the disposition family.
 */
test("insertScenario — legacy membership edge TYPES (realizes/traverses) are NOT emitted", () => {
  const graph = makeGraph();
  const overlay = makeScenarioOverlay(graph);
  const node = overlay.insertScenario({
    scenarioId: "sid-retire",
    capabilityUnitId: "uid-retire",
    entryElementId: "e",
    entryName: "e",
    contentHash: "h",
    steps: [makeStep(0, "c0", "c1")],
    traversedClusters: ["c0", "c1"],
  });
  const plainRealizes = graph.edgesFrom(node.id, { type: "realizes", includeDangling: true });
  const plainTraverses = graph.edgesFrom(node.id, { type: "traverses", includeDangling: true });
  assert.equal(plainRealizes.length, 0, "membership realizes edge TYPE must not be emitted");
  assert.equal(plainTraverses.length, 0, "membership traverses edge TYPE must not be emitted");

  // Every outgoing edge from the scenario node is `analysis-disposition`.
  const allOutgoing = graph.edgesFrom(node.id, { includeDangling: true });
  for (const e of allOutgoing) {
    assert.equal(e.type, ANALYSIS_DISPOSITION_EDGE_TYPE);
  }
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

test("scenarioForUnit — DANGLING case: walks the realizes disposition edge by its domain-prefixed targetRef", () => {
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
  // The L2 unit node is never materialized in this test — the
  // disposition realizes edge stays dangling, targetRef
  // `capability-unit://myUnit`. `scenarioForUnit` must derive that
  // prefixed form itself; querying with the raw id misses it (the wave
  // 4 KNOWN TRAP).
  const scenario = overlay.scenarioForUnit("myUnit");
  assert.ok(scenario);
  assert.equal(scenario!.metadata.scenarioId, "s");
});

test("scenarioForUnit — RESOLVED case: the unit node materializes AFTER the scenario, upgrading the dangling disposition edge to targetId", () => {
  const graph = makeGraph();
  const overlay = makeScenarioOverlay(graph);
  overlay.insertScenario({
    scenarioId: "s-resolved",
    capabilityUnitId: "uid-resolves-later",
    entryElementId: "e",
    entryName: "e",
    contentHash: "h",
    steps: [],
    traversedClusters: [],
  });

  // Confirm it started dangling.
  const beforeMaterialize = overlay.realizesEdge("s-resolved");
  assert.equal(beforeMaterialize?.targetId, null);
  assert.equal(beforeMaterialize?.targetRef, "capability-unit://uid-resolves-later");

  // NOW materialize the unit node — the substrate's dangling-resolution
  // mechanism (`resolveDanglingEdgesFor`, node-insert-triggered) upgrades
  // the disposition edge to a resolved targetId because the ref's
  // cross-domain-URI form exactly matches `${domain}://${naturalKey}`.
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
        naturalKey: "uid-resolves-later",
        contentHash: "uch",
        metadata: {},
      }),
  ).result;

  const afterMaterialize = overlay.realizesEdge("s-resolved");
  assert.equal(afterMaterialize?.targetId, unitNode.id, "disposition edge upgraded to resolved targetId");
  assert.equal(afterMaterialize?.targetRef, null);

  // `scenarioForUnit` must find it via the RESOLVED (edgesTo) path when
  // called with the now-live unit's id.
  const byId = overlay.scenarioForUnit(unitNode.id);
  assert.ok(byId, "scenarioForUnit must resolve via edgesTo when passed a live node id");
  assert.equal(byId!.metadata.scenarioId, "s-resolved");

  // Also findable by the natural key (naturalKey === node id form isn't
  // required for correctness here — this exercises the branch where
  // getNodeById(naturalKey) misses, but the resolved edge is still found
  // through the id-based edgesTo lookup keyed off the SAME unit node).
  const byNaturalKey = overlay.scenarioForUnit("uid-resolves-later");
  assert.ok(byNaturalKey, "scenarioForUnit must also resolve via the natural key");
  assert.equal(byNaturalKey!.metadata.scenarioId, "s-resolved");
});

test("scenarioForUnit — undefined when no scenario realizes the unit", () => {
  const graph = makeGraph();
  const overlay = makeScenarioOverlay(graph);
  assert.equal(overlay.scenarioForUnit("nothing"), undefined);
});

test("traversesEdges — subtype is the disposition kind, not a stepIndex; step detail lives in metadata.steps", () => {
  const graph = makeGraph();
  const overlay = makeScenarioOverlay(graph);
  const node = overlay.insertScenario({
    scenarioId: "s",
    capabilityUnitId: "u",
    entryElementId: "e",
    entryName: "e",
    contentHash: "h",
    steps: [makeStep(0, "c0", "c1")],
    traversedClusters: ["c0", "c1"],
  });
  const edges = overlay.traversesEdges("s");
  assert.equal(edges.length, 2);
  // subtype is the disposition PRIMARY kind ("traverses") on every edge
  // — the legacy membership edge's per-step `subtype` (the stringified
  // stepIndex) retired with the membership edge type itself.
  for (const e of edges) assert.equal(e.subtype, "traverses");
  // Step-level detail (stepIndex, source/target element) is NOT on the
  // edge — callers needing it read the scenario node's metadata.steps.
  assert.equal(node.metadata.steps.length, 1);
  assert.equal(node.metadata.steps[0].stepIndex, 0);
  for (const e of edges) {
    assert.equal((e.metadata as Record<string, unknown> | null)?.stepIndex, undefined);
  }
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

test("insertScenario — emits a realizes disposition edge, scenario→L2 unit, always targetRef in domain://naturalKey form", () => {
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

  const dispositionOverlay = makeDispositionOverlay(graph);
  const dispositions = dispositionOverlay.dispositionsOf(node.id);
  const realizesDisposition = dispositions.find((e) => e.subtype === "realizes");
  assert.ok(realizesDisposition, "expected an analysis-disposition edge with subtype realizes");
  assert.equal(realizesDisposition!.type, ANALYSIS_DISPOSITION_EDGE_TYPE);
  assert.equal(realizesDisposition!.targetId, null);
  // ALWAYS the cross-domain URI form — independent of whether the L2
  // unit is materialized.
  assert.equal(realizesDisposition!.targetRef, "capability-unit://uid-disp-1");
  assert.deepEqual((realizesDisposition!.metadata as { kinds: string[] }).kinds, ["realizes"]);

  // `realizesEdge` (the public read) returns this exact edge — it IS the
  // membership record now.
  const viaOverlay = overlay.realizesEdge("sid-disp-1");
  assert.equal(viaOverlay?.id, realizesDisposition!.id);
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

  // The unit was already live BEFORE the scenario's disposition edge was
  // written — `insertEdge`'s eager tail-match never fires for a pure-hex
  // (no `#`) domain-prefixed ref, so the edge stays DANGLING even though
  // its real target is live. Per the design's "always targetRef" ruling:
  // the disposition form is independent of resolvability.
  const dispositionOverlay = makeDispositionOverlay(graph);
  const realizesDisposition = dispositionOverlay
    .dispositionsOf(node.id)
    .find((e) => e.subtype === "realizes");
  assert.ok(realizesDisposition);
  assert.equal(realizesDisposition!.targetId, null);
  assert.equal(realizesDisposition!.targetRef, "capability-unit://uid-disp-materialized");

  const viaOverlay = overlay.realizesEdge("sid-disp-2");
  assert.equal(viaOverlay?.targetId, null);
  assert.equal(viaOverlay?.targetRef, "capability-unit://uid-disp-materialized");
});

test("insertScenario — traverses disposition edges are ONE per distinct cluster, even when multiple steps land in the same cluster; step detail stays out of the edge", () => {
  const graph = makeGraph();
  const overlay = makeScenarioOverlay(graph);
  // Two DIFFERENT steps both target "domain" — the disposition edge
  // collapses to one per cluster (not secretly one-per-step).
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

  const traversesViaOverlay = overlay.traversesEdges("sid-disp-3");
  assert.equal(
    traversesViaOverlay.length,
    2,
    "one disposition edge per DISTINCT cluster (controllers, domain) — not one per step",
  );

  const dispositionOverlay = makeDispositionOverlay(graph);
  const dispositions = dispositionOverlay.dispositionsOf(node.id);
  const traversesDispositions = dispositions.filter((e) => e.subtype === "traverses");
  assert.equal(traversesDispositions.length, 2);
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

// ---------------------------------------------------------------------
// Fathom row 3.1.8.4 wave 4 — DRIFT PARITY. Disposition edges retiring
// membership means they ARE the membership record: live disposition
// edges MUST equal current membership after every insert/re-insert,
// exactly like the legacy membership `realizes` edge's tombstone-on-drift
// (`doInsertScenario`'s old lines 164-176) already did. Both drift tests
// below use the SAME contentHash across two `insertScenario` calls
// specifically so the node is NOT superseded (no substrate
// cascade-tombstone of the prior tip's outgoing edges) — this isolates
// the overlay's OWN reconciliation logic as the thing under test, not
// `supersedeNode`'s unrelated cascade.
// ---------------------------------------------------------------------

test("insertScenario — DRIFT PARITY: a changed capability unit tombstones the stale realizes disposition edge", () => {
  const graph = makeGraph();
  const overlay = makeScenarioOverlay(graph);
  overlay.insertScenario({
    scenarioId: "sid-drift-1",
    capabilityUnitId: "uid-old",
    entryElementId: "e",
    entryName: "e",
    contentHash: "h-same",
    steps: [],
    traversedClusters: [],
  });
  const b = overlay.insertScenario({
    scenarioId: "sid-drift-1",
    capabilityUnitId: "uid-new",
    entryElementId: "e",
    entryName: "e",
    contentHash: "h-same",
    steps: [],
    traversedClusters: [],
  });

  const live = overlay.realizesEdge("sid-drift-1");
  assert.ok(live);
  assert.equal(live!.targetRef, "capability-unit://uid-new");

  const staleAny = graph.queryEdges({
    targetRef: "capability-unit://uid-old",
    type: ANALYSIS_DISPOSITION_EDGE_TYPE,
  });
  assert.equal(staleAny.length, 1, "the stale edge must still exist (tombstoned), not vanish untracked");
  assert.equal(staleAny[0]!.lifecycleState, "tombstoned");

  // Live disposition set == current membership, exactly one realizes edge.
  const dispositionOverlay = makeDispositionOverlay(graph);
  const liveRealizes = dispositionOverlay
    .dispositionsOf(b.id)
    .filter((e) => e.subtype === "realizes");
  assert.equal(liveRealizes.length, 1);
});

test("insertScenario — DRIFT PARITY: a departed cluster tombstones the stale traverses disposition edge", () => {
  const graph = makeGraph();
  const overlay = makeScenarioOverlay(graph);
  overlay.insertScenario({
    scenarioId: "sid-drift-2",
    capabilityUnitId: "u",
    entryElementId: "e",
    entryName: "e",
    contentHash: "h-same-2",
    steps: [],
    traversedClusters: ["c0", "c1"],
  });
  overlay.insertScenario({
    scenarioId: "sid-drift-2",
    capabilityUnitId: "u",
    entryElementId: "e",
    entryName: "e",
    contentHash: "h-same-2",
    steps: [],
    traversedClusters: ["c1", "c2"], // c0 departed, c2 arrived
  });

  const live = overlay.traversesEdges("sid-drift-2");
  const liveTargets = live.map((e) => e.targetRef ?? e.targetId).sort();
  assert.deepEqual(liveTargets, ["c1", "c2"]);

  const staleC0 = graph.queryEdges({ targetRef: "c0", type: ANALYSIS_DISPOSITION_EDGE_TYPE });
  assert.equal(staleC0.length, 1, "the departed cluster's edge must still exist (tombstoned)");
  assert.equal(staleC0[0]!.lifecycleState, "tombstoned");
});
