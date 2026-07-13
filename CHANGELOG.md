# Changelog

## [0.6.0] — 2026-07-13

**BREAKING — intra-cluster call steps are now EMITTED** (Fathom row `l5-intracluster-step-sparsity` 3.1.5.3, crit 4). **L5's solid declaration was REOPENED for this.**

`recovery.ts` skipped every call whose source and target sat in the same cluster:

```ts
if (srcCluster === tgtCluster) continue;  // intra-cluster, skip
```

That discarded **83.6% of all closure call edges** (2,089 of 2,498 on the Fathom corpus), projecting what survived onto just **45 cluster-pairs**. Distinct operations therefore handed L7a **byte-identical step streams** — the root cause of its confidence saturation — and it is why **1,090 of 1,220 scenarios had ZERO steps** (569 of them lost *every* call to this line; only 490 were genuine leaves).

**The signal was always in the fact graph. L5 simply chose not to emit it.** Its gates passed *honestly* — they measured what L5 CHOSE to emit and never whether that choice carried enough information for the layer above. That is precisely the emission-vs-resolution completeness blind spot `baselines.md` warns about.

### Changed

- `src/recovery.ts` — intra-cluster steps are emitted.
- `src/types.ts` — `TransitionStep.intraCluster: boolean`. **The marker is not decoration**: it keeps the semantic change OBSERVABLE rather than silent (no-silent-degradation), so a consumer wanting the old inter-cluster-only projection can still recover it by filtering, instead of having the projection imposed on everyone.

### Tests

- The test asserting *"intra-cluster calls collapse (no step)"* **PINNED this bug as intended behaviour**. Flipped, with the history recorded in place.
- **Red fixture (from the row):** two scenarios with *identical* inter-cluster crossings but different intra-cluster call structure must be distinguishable. Pre-fix they produced byte-identical step streams. 33/33 pass.

**Live:** 2,334 intra-cluster steps recovered on the Fathom corpus (307 → 2,641 total).

**Blast radius:** L5 output ~5×; every downstream L7a partition and `useCaseId` re-forms. Pre-prod — delete + re-analyze.

All notable changes to `@kepello/nodegraph-scenarios`. Format follows [Keep a Changelog](https://keepachangelog.com/).

## [0.5.0] — 2026-07-10

`computeScenarioId` migrated onto `@kepello/nodegraph-core`'s shared `shortContentHash` helper. Step 4 of Fathom row `0.3.2.f8` (identity-hash-helper-consolidation). Behavior-preserving — golden-pinned; no id change → no downstream cache concern from this package.

### Changed

- `computeScenarioId` now calls `shortContentHash([capabilityUnitId, capabilityUnitContentHash])` instead of hand-rolling the sha256-then-slice(0,16) assembly. Local `SHORT_HASH_LENGTH` const removed.
- Peer dependency on `@kepello/nodegraph-core` retargeted `^5.7.1` → `^5.12.0` (introduces `shortContentHash`).

### Tests

- 1 new golden-pin regression test: fixed input `computeScenarioId("unit-golden-id", "unit-golden-contenthash")` asserts the exact pre-migration literal `72485e4963c0698e`. Captured green against the un-migrated code, stayed green after the migration — byte-identity confirmed. 32/32 tests pass (was 31).

## [0.4.1] — 2026-07-06

**Reviewer F1 fix (HIGH, confirmed by execution) on the 5.0.116 wave — the 0.4.0 tiebreak keyed ties on `target`, which is itself a substrate node id minted as a RANDOM UUIDv4 per insert (`nodegraph-core` `graph-layer.ts:505`), NOT rebuild-stable.** Tied steps (identical position, or both missing a position — every .NET/Swift edge until position parity lands) ordered randomly across independent clean rebuilds of the same source, because the fresh UUIDs minted each rebuild compare differently — the L5 baseline's zero-divergence gate would fail on position-less scenarios. The 0.4.0 shipped tie tests used stable string ids (`"aTarget"`/`"zTarget"`) so they could never witness this — false green.

**Correction to the 0.4.0 changelog entry below:** its language claimed the target-id tiebreak "makes tied steps deterministic independent of arrival order," and implied this delivers cross-rebuild stability. That claim is only half true — it IS arrival-order-independent within a single graph's lifetime, but it is NOT rebuild-stable, because `target` itself changes identity (fresh UUID) on every rebuild. Cross-rebuild stability is what THIS release actually delivers, via `targetKey`.

### Changed

- **`CallEdge`** gains an optional `targetKey?: string` — a rebuild-stable identifier for `target` (the target element's natural key). `compareByLocation`'s tiebreak now prefers `targetKey` when supplied, falling back to `target` for callers that don't supply one (API-compatible; determinism is guaranteed only when `targetKey` is supplied). Applies to both tie shapes: identical `sourceLine`/`sourceColumn`, and both edges lacking a `sourceLine` entirely.

### Tests

- 1 new `computeScenarios` regression: two independent runs over the same logical edges (same `source`, same `targetKey`) with DIFFERENT `target` UUID values (modeling fresh mints across rebuilds) — asserts the step sequence, projected onto the stable `targetKey`, is IDENTICAL across both runs. RED against the pre-fix tiebreak (order flips with the UUIDs: run1 → `["widgetRepo","authService"]`, run2 → `["authService","widgetRepo"]`); GREEN after. Existing arrival-order-permutation tie tests kept unchanged. Full suite: 31/31 (30 → 31).

## [0.4.0] — 2026-07-05

Deterministic step-order tiebreak (Fathom row `edge-source-position-provenance`, 5.0.116 leg 3, M2). `compareByLocation` ties — identical line+column, or both edges missing a position — previously fell back to array-sort stability over the caller's arrival order; that order comes from an un-ordered backend query (no `ORDER BY`; row order is an implementation accident, not a contract), so it was not guaranteed stable across rebuilds.

### Changed

- **`compareByLocation`** — tied edges now break on `target` element id (lexicographic) instead of preserving arrival order. Applies to both tie shapes: identical `sourceLine`/`sourceColumn`, and both edges lacking a `sourceLine` entirely.

### Tests

- 2 new `computeScenarios` regression tests pin both tie shapes, each asserting the step order is unchanged when the input `callEdges` array is reversed. 1 new `insertScenario` pin confirms step `sourceLocation` round-trips through `buildMetadata` unchanged (no fix needed there — pinned against future regression). Full suite: 30/30 (27 → 30).

## [0.3.1] — 2026-06-10

Document the `realizes`-edge targetRef pattern (Fathom row 5.0.96, `l2-realizes-hex-targetref-labeling`). No behavior change — patch bump for doc-only.

### Changed

- **`overlay.ts` module doc** — added a detailed design block ("`realizes` targetRef pattern — query-time structured targets") explaining: `targetRef` on a `realizes` edge carries the L2 capability-unit NATURAL KEY (a pure-hex content hash); the substrate deliberately never tail-resolves pure-hex keys because they are maximally ambiguous across domains; resolution is deferred to query time via `queryEdges({ targetRef })` or `ScenarioOverlay.scenarioForUnit`; consumers MUST use those paths and MUST NOT treat a dangling `realizes` edge as data loss.

## [0.3.0] — 2026-05-28

Adopt the per-overlay schema-version stamp (Fathom row 1.12.3). Exports `SCENARIO_SCHEMA_VERSION` (= 1, V1 baseline) and declares it on the overlay's `OverlayRegistration`.

### Changed

- Registration now passes the mandatory `schemaVersion` field added in substrate 1.12.2. Peer dependency on `@kepello/nodegraph-core` retargeted to `^3.0.0`. No behavior change beyond the version stamp.

## [0.1.0] — 2026-05-14

Initial publish. Fifth layer of the workspace Layered Code Abstraction arc (Fathom work row `l5-scenario-overlay` 3.1.5, per `docs/code_abstraction.md` L5).

### Added

- `SCENARIO_DOMAIN` + `SCENARIO_METADATA_SCHEMA` + indexes (`scenarios_by_scenario_id` unique, `scenarios_by_capability_unit`, `scenarios_by_language`, `scenarios_by_entry`).
- `ScenarioMetadata`, `ScenarioInput`, `ScenarioNode`, `ScenarioOverlay`, `TransitionStep` interfaces.
- `makeScenarioOverlay(graph)` factory — registers domain + indexes; exposes `insertScenario` / `tombstoneScenario` writes and `listScenarios` / `getScenario` / `scenarioForUnit` reads.
- `computeScenarios({ units, callEdges, clusterByElement, stereotypeByElement?, layerByCluster? })` — pure algorithm. For each L2 capability unit, walks the closure's call edges in lexical source-position order, projects each call to a cluster-pair, and emits one `TransitionStep` per inter-cluster boundary (intra-cluster sequences collapse to nothing). Steps annotated with source/target cluster, source/target L1 method-stereotype (when provided), and source/target L4 layer number (when provided).
- `computeScenarioId(capabilityUnitId, capabilityUnitContentHash)` — stable content-hash identity helper.
- `REALIZES_EDGE_TYPE` / `TRAVERSES_EDGE_TYPE` edge type constants.

### Trade-offs (v1 — documented limitations)

- **Lexical-order ordering flattens branches and loops to textual order** — no CFG fidelity. Real control-flow ordering parked as Fathom `l5-cfg-walk-extension` (3.1.5.1).
- **Dynamic dispatch treated as direct calls** — `isBranching` is always `false` in v1; the wire protocol doesn't yet surface dispatch kind. Real branching-marker support gated on Fathom `l2-virtual-dispatch-protocol-extension` (3.1.2.1).
- **Cross-language scenarios unsupported** — no cross-language calls in L0 graph; scenarios stay per-language until workspace-level link records exist.
- **No output-driven slicing** in v1 — parked as Fathom `l5-slicing-extension` (3.1.5.2).
- **Annotations are optional** — `stereotypeByElement` (from L1) and `layerByCluster` (from L4) are accepted as inputs but absent when consumers haven't run the corresponding analyses; degrades gracefully.

### Schema-versioning note

Registers without `schemaVersion` because `nodegraph-core@1.1.1` doesn't yet enforce the field. Will declare `schemaVersion: 1` when Fathom row `overlay-version-and-migration-substrate` (1.12.2) ships. Same posture as the other Phase-3 packages shipped this session.
