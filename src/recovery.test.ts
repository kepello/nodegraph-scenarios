/**
 * Scenario-recovery algorithm tests. Pins:
 *
 *   - One scenario per L2 unit.
 *   - Steps emitted in lexical source-position order.
 *   - Intra-cluster calls do not emit steps (collapse).
 *   - Each step crosses a cluster boundary.
 *   - traversedClusters lists distinct clusters in first-seen order.
 *   - Stereotype + layer annotations populate when provided.
 *   - Unknown cluster (element not in clusterByElement) → call skipped.
 *   - Self-loops are no-ops (same source/target cluster collapses).
 *   - Empty input → empty result.
 *   - Edges with no sourceLine sort to the end of the unit's edges.
 *   - isBranching is false in v1 (dispatch info absent).
 *   - Determinism: same input → same output.
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { computeScenarios, type CallEdge, type UnitInput } from "./recovery.js";

function unit(overrides: Partial<UnitInput> & { unitId: string; entryElementId: string }): UnitInput {
  return {
    unitId: overrides.unitId,
    entryElementId: overrides.entryElementId,
    entryName: overrides.entryName ?? overrides.entryElementId,
    contentHash: overrides.contentHash ?? `ch_${overrides.unitId}`,
    ownedElementIds: overrides.ownedElementIds ?? [],
    usedElementIds: overrides.usedElementIds ?? [],
    language: overrides.language,
  };
}

function edge(source: string, target: string, line?: number, column?: number): CallEdge {
  return { source, target, sourceLine: line, sourceColumn: column };
}

test("computeScenarios — empty input returns empty result", () => {
  const result = computeScenarios({
    units: [],
    callEdges: [],
    clusterByElement: new Map(),
  });
  assert.equal(result.scenarios.length, 0);
});

test("computeScenarios — one scenario per unit", () => {
  const result = computeScenarios({
    units: [
      unit({ unitId: "u1", entryElementId: "a" }),
      unit({ unitId: "u2", entryElementId: "b" }),
    ],
    callEdges: [],
    clusterByElement: new Map([
      ["a", "c1"],
      ["b", "c2"],
    ]),
  });
  assert.equal(result.scenarios.length, 2);
});

test("computeScenarios — steps emitted in lexical source-position order", () => {
  const result = computeScenarios({
    units: [
      unit({
        unitId: "u",
        entryElementId: "entry",
      }),
    ],
    callEdges: [
      edge("entry", "A", 10),
      edge("entry", "B", 5),
      edge("entry", "C", 20),
    ],
    clusterByElement: new Map([
      ["entry", "controllers"],
      ["A", "domain"],
      ["B", "data"],
      ["C", "telemetry"],
    ]),
  });
  const steps = result.scenarios[0].steps;
  // Sorted by line: B (5), A (10), C (20).
  assert.equal(steps[0].targetElementId, "B");
  assert.equal(steps[1].targetElementId, "A");
  assert.equal(steps[2].targetElementId, "C");
});

test("computeScenarios — intra-cluster calls collapse (no step)", () => {
  const result = computeScenarios({
    units: [
      unit({
        unitId: "u",
        entryElementId: "entry",
        ownedElementIds: ["helper"],
      }),
    ],
    callEdges: [
      // entry and helper are both in `domain` cluster — intra-cluster.
      edge("entry", "helper", 1),
      // entry → telemetry crosses boundary.
      edge("entry", "logActivity", 2),
    ],
    clusterByElement: new Map([
      ["entry", "domain"],
      ["helper", "domain"],
      ["logActivity", "telemetry"],
    ]),
  });
  const steps = result.scenarios[0].steps;
  // Only the cross-boundary step is emitted.
  assert.equal(steps.length, 1);
  assert.equal(steps[0].targetCluster, "telemetry");
});

test("computeScenarios — traversedClusters lists distinct clusters in first-seen order", () => {
  const result = computeScenarios({
    units: [
      unit({ unitId: "u", entryElementId: "entry" }),
    ],
    callEdges: [
      edge("entry", "x", 1),
      edge("entry", "y", 2),
      edge("entry", "z", 3),
    ],
    clusterByElement: new Map([
      ["entry", "c0"],
      ["x", "c1"],
      ["y", "c2"],
      ["z", "c1"], // same as x's cluster
    ]),
  });
  const traversed = result.scenarios[0].traversedClusters;
  assert.deepEqual(traversed, ["c0", "c1", "c2"]);
});

test("computeScenarios — stereotype + layer annotations populate when provided", () => {
  const result = computeScenarios({
    units: [unit({ unitId: "u", entryElementId: "entry" })],
    callEdges: [edge("entry", "helper", 1)],
    clusterByElement: new Map([
      ["entry", "controllers"],
      ["helper", "data"],
    ]),
    stereotypeByElement: new Map([
      ["entry", "controller"],
      ["helper", "accessor-shaped"],
    ]),
    layerByCluster: new Map([
      ["controllers", 2],
      ["data", 0],
    ]),
  });
  const step = result.scenarios[0].steps[0];
  assert.equal(step.sourceStereotype, "controller");
  assert.equal(step.targetStereotype, "accessor-shaped");
  assert.equal(step.sourceLayer, 2);
  assert.equal(step.targetLayer, 0);
});

test("computeScenarios — call to element not in clusterByElement is skipped", () => {
  const result = computeScenarios({
    units: [unit({ unitId: "u", entryElementId: "entry" })],
    callEdges: [
      edge("entry", "known", 1),
      edge("entry", "OFF_GRAPH", 2),
    ],
    clusterByElement: new Map([
      ["entry", "c0"],
      ["known", "c1"],
    ]),
  });
  const steps = result.scenarios[0].steps;
  assert.equal(steps.length, 1);
  assert.equal(steps[0].targetElementId, "known");
});

test("computeScenarios — isBranching is false in v1", () => {
  const result = computeScenarios({
    units: [unit({ unitId: "u", entryElementId: "entry" })],
    callEdges: [edge("entry", "x", 1)],
    clusterByElement: new Map([
      ["entry", "c0"],
      ["x", "c1"],
    ]),
  });
  const step = result.scenarios[0].steps[0];
  assert.equal(step.isBranching, false);
  assert.deepEqual(step.candidateTargetIds, ["x"]);
});

test("computeScenarios — edges with no sourceLine sort to the end", () => {
  const result = computeScenarios({
    units: [unit({ unitId: "u", entryElementId: "entry" })],
    callEdges: [
      edge("entry", "noLine"), // no line — sorts last
      edge("entry", "first", 1),
      edge("entry", "second", 5),
    ],
    clusterByElement: new Map([
      ["entry", "c0"],
      ["first", "c1"],
      ["second", "c2"],
      ["noLine", "c3"],
    ]),
  });
  const targets = result.scenarios[0].steps.map((s) => s.targetElementId);
  assert.deepEqual(targets, ["first", "second", "noLine"]);
});

test("computeScenarios — determinism: same input → same output", () => {
  const input = {
    units: [
      unit({ unitId: "u1", entryElementId: "a", ownedElementIds: ["h"] }),
    ],
    callEdges: [
      edge("a", "h", 1),
      edge("a", "x", 2),
    ],
    clusterByElement: new Map([
      ["a", "c0"],
      ["h", "c0"],
      ["x", "c1"],
    ]),
  };
  const a = computeScenarios(input);
  const b = computeScenarios(input);
  assert.deepEqual(
    a.scenarios.map((s) => s.scenarioId),
    b.scenarios.map((s) => s.scenarioId),
  );
});

test("computeScenarios — language inherited from unit", () => {
  const result = computeScenarios({
    units: [
      unit({
        unitId: "u",
        entryElementId: "entry",
        language: "typescript",
      }),
    ],
    callEdges: [edge("entry", "x", 1)],
    clusterByElement: new Map([
      ["entry", "c0"],
      ["x", "c1"],
    ]),
  });
  assert.equal(result.scenarios[0].language, "typescript");
});

test("computeScenarios — scenarios sorted by entryElementId for stability", () => {
  const result = computeScenarios({
    units: [
      unit({ unitId: "uZ", entryElementId: "zEntry" }),
      unit({ unitId: "uA", entryElementId: "aEntry" }),
    ],
    callEdges: [],
    clusterByElement: new Map([
      ["zEntry", "c1"],
      ["aEntry", "c1"],
    ]),
  });
  assert.equal(result.scenarios[0].entryElementId, "aEntry");
  assert.equal(result.scenarios[1].entryElementId, "zEntry");
});
