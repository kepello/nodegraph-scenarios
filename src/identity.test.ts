/**
 * scenarioId-hash tests. Pins:
 *
 *   - Same (unitId, contentHash) → same scenarioId.
 *   - Different unitId → different scenarioId.
 *   - Different contentHash → different scenarioId.
 *   - Short fixed-width hex output.
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { computeScenarioId } from "./identity.js";

test("computeScenarioId — deterministic on same inputs", () => {
  const a = computeScenarioId("u1", "ch1");
  const b = computeScenarioId("u1", "ch1");
  assert.equal(a, b);
});

test("computeScenarioId — different unitId yields different id", () => {
  assert.notEqual(
    computeScenarioId("u1", "ch1"),
    computeScenarioId("u2", "ch1"),
  );
});

test("computeScenarioId — different contentHash yields different id", () => {
  assert.notEqual(
    computeScenarioId("u1", "v1"),
    computeScenarioId("u1", "v2"),
  );
});

test("computeScenarioId — short fixed-width hex", () => {
  const id = computeScenarioId("u", "ch");
  assert.match(id, /^[0-9a-f]{16}$/);
});

test("computeScenarioId — golden pin (byte-identity across the shortContentHash migration)", () => {
  // Captured against the pre-migration sha256(capabilityUnitId + '\n' +
  // capabilityUnitContentHash) assembly. Must stay byte-identical after
  // routing through the shared shortContentHash helper — id churn here is
  // a supersession storm.
  const id = computeScenarioId("unit-golden-id", "unit-golden-contenthash");
  assert.equal(id, "72485e4963c0698e");
});
