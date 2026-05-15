/**
 * Scenario-identity computation. `scenarioId = sha256(capabilityUnitId
 * || '\n' || capabilityUnitContentHash)` truncated to 16 hex chars
 * (64 bits). Identity tracks the underlying unit's identity — when the
 * unit's closure changes, its contentHash changes, the scenarioId changes.
 *
 * This makes scenarios second-class identity-wise: they're regenerated
 * whenever their unit is. That's intentional — a scenario IS the static
 * trace of a specific unit at a specific version. Trying to keep
 * scenario identity stable across unit-content changes would require
 * tracking a separate semantic "what does this trace mean" id, which
 * v1 leaves to the operator (via `displayName` overrides).
 */

import { createHash } from "node:crypto";

const SHORT_HASH_LENGTH = 16;

export function computeScenarioId(
  capabilityUnitId: string,
  capabilityUnitContentHash: string,
): string {
  const hasher = createHash("sha256");
  hasher.update(capabilityUnitId);
  hasher.update("\n");
  hasher.update(capabilityUnitContentHash);
  return hasher.digest("hex").slice(0, SHORT_HASH_LENGTH);
}
