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
 *   - Ties (identical line+column, or both missing a position) break by
 *     target id, independent of the edges' arrival order (5.0.116 M2).
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

/**
 * Regression for Fathom row edge-source-position-provenance (5.0.116),
 * M2 (deterministic step order). `compareByLocation` ties (same
 * line+column, or both missing a position) fell back to array-sort
 * stability over the CALLER's arrival order — and that order comes
 * from an un-ordered backend `SELECT` (nodegraph-sqlite issues no
 * `ORDER BY`; row order is an implementation accident, not a
 * contract), so it is NOT guaranteed stable across rebuilds. Pin a
 * final tiebreak (target element id, lexicographic) so tied edges
 * sort identically regardless of arrival order.
 */
test("computeScenarios — ties on identical line+column break by target id, independent of arrival order", () => {
  const input = {
    units: [unit({ unitId: "u", entryElementId: "entry" })],
    callEdges: [
      edge("entry", "zTarget", 1, 1),
      edge("entry", "aTarget", 1, 1),
    ],
    clusterByElement: new Map([
      ["entry", "c0"],
      ["zTarget", "c1"],
      ["aTarget", "c2"],
    ]),
  };
  const targets = computeScenarios(input).scenarios[0].steps.map((s) => s.targetElementId);
  assert.deepEqual(targets, ["aTarget", "zTarget"]);

  const reversedTargets = computeScenarios({
    ...input,
    callEdges: [...input.callEdges].reverse(),
  }).scenarios[0].steps.map((s) => s.targetElementId);
  assert.deepEqual(
    reversedTargets,
    targets,
    "tie order must not depend on the edges' arrival order",
  );
});

test("computeScenarios — edges with no position break ties by target id, independent of arrival order", () => {
  const input = {
    units: [unit({ unitId: "u", entryElementId: "entry" })],
    callEdges: [
      edge("entry", "zTarget"),
      edge("entry", "aTarget"),
    ],
    clusterByElement: new Map([
      ["entry", "c0"],
      ["zTarget", "c1"],
      ["aTarget", "c2"],
    ]),
  };
  const targets = computeScenarios(input).scenarios[0].steps.map((s) => s.targetElementId);
  assert.deepEqual(targets, ["aTarget", "zTarget"]);

  const reversedTargets = computeScenarios({
    ...input,
    callEdges: [...input.callEdges].reverse(),
  }).scenarios[0].steps.map((s) => s.targetElementId);
  assert.deepEqual(
    reversedTargets,
    targets,
    "tie order must not depend on the edges' arrival order",
  );
});

/**
 * Regression for Fathom row edge-source-position-provenance (5.0.116),
 * reviewer F1 (HIGH, confirmed by execution). The 0.4.0 tiebreak keyed
 * ties on `target` — but `target` is a substrate node id minted as a
 * RANDOM UUIDv4 per insert (nodegraph-core `graph-layer.ts:505`), NOT
 * rebuild-stable. Tied steps (identical position, or both missing a
 * position — every .NET/Swift edge until position parity lands) would
 * order randomly across independent clean rebuilds of the SAME source,
 * because the fresh UUIDs minted each rebuild compare differently.
 *
 * This fixture models two independent rebuilds of the same logical
 * edges: same `source`, same `targetKey` (the rebuild-stable natural
 * key), but DIFFERENT `target` UUID values (fresh mints). Asserts the
 * step sequence — projected onto the stable `targetKey` — is IDENTICAL
 * across both runs.
 *
 * RED against the pre-fix tiebreak (keyed on `target` alone, ignoring
 * `targetKey`): the chosen UUID pairs are constructed so `target`
 * comparison flips order between the two runs while `targetKey`
 * comparison does not — so the old code's step order differs between
 * "rebuild 1" and "rebuild 2" even though the logical scenario is
 * unchanged. GREEN once the tiebreak prefers `targetKey`.
 */
test("computeScenarios — tie order is rebuild-stable via targetKey, independent of remint UUIDs (5.0.116 reviewer F1)", () => {
  // Run 1's UUIDs.
  const RUN1_WIDGET_REPO = "11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const RUN1_AUTH_SERVICE = "99999999-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  // Run 2's UUIDs — fresh mints for the SAME two logical targets.
  // Chosen so `target`-only comparison FLIPS vs. run 1 ("111..." <
  // "999..." but "222..." < "888...", so a naive `target` tiebreak
  // orders widgetRepo first in run 1 and authService first in run 2)
  // while `targetKey` comparison ("authService" < "widgetRepo") stays
  // constant across both runs.
  const RUN2_WIDGET_REPO = "88888888-cccc-4ccc-8ccc-cccccccccccc";
  const RUN2_AUTH_SERVICE = "22222222-dddd-4ddd-8ddd-dddddddddddd";

  const targetKeyByTarget = new Map([
    [RUN1_WIDGET_REPO, "widgetRepo"],
    [RUN1_AUTH_SERVICE, "authService"],
    [RUN2_WIDGET_REPO, "widgetRepo"],
    [RUN2_AUTH_SERVICE, "authService"],
  ]);

  const clusterByElement = new Map([
    ["entry", "controllers"],
    [RUN1_WIDGET_REPO, "dataCluster"],
    [RUN1_AUTH_SERVICE, "authCluster"],
    [RUN2_WIDGET_REPO, "dataCluster"],
    [RUN2_AUTH_SERVICE, "authCluster"],
  ]);

  // Both edges miss a position — the tie shape every .NET/Swift edge
  // hits until position parity lands.
  const run1 = computeScenarios({
    units: [unit({ unitId: "u", entryElementId: "entry" })],
    callEdges: [
      { ...edge("entry", RUN1_WIDGET_REPO), targetKey: "widgetRepo" },
      { ...edge("entry", RUN1_AUTH_SERVICE), targetKey: "authService" },
    ],
    clusterByElement,
  });

  const run2 = computeScenarios({
    units: [unit({ unitId: "u", entryElementId: "entry" })],
    callEdges: [
      { ...edge("entry", RUN2_WIDGET_REPO), targetKey: "widgetRepo" },
      { ...edge("entry", RUN2_AUTH_SERVICE), targetKey: "authService" },
    ],
    clusterByElement,
  });

  const projectedTargetKeys1 = run1.scenarios[0].steps.map(
    (s) => targetKeyByTarget.get(s.targetElementId),
  );
  const projectedTargetKeys2 = run2.scenarios[0].steps.map(
    (s) => targetKeyByTarget.get(s.targetElementId),
  );

  assert.deepEqual(
    projectedTargetKeys1,
    projectedTargetKeys2,
    `step order must be rebuild-stable projected onto targetKey; run1=${JSON.stringify(projectedTargetKeys1)} run2=${JSON.stringify(projectedTargetKeys2)}`,
  );
  // Pin the actual stable order too: authService < widgetRepo lexically.
  assert.deepEqual(projectedTargetKeys1, ["authService", "widgetRepo"]);
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
