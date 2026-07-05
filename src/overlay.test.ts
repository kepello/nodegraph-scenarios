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
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  GraphLayerImpl,
  type GraphLayer,
} from "@kepello/nodegraph-core";
import { InMemoryBackend } from "@kepello/nodegraph-core/in-memory";
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
