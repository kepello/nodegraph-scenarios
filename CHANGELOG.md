# Changelog

## [0.8.1] — 2026-07-19

Peer-floor sync, 5.0.139 sweep-gap cascade — no code change. `@kepello/nodegraph-dispositions` peer floor `^0.2.0` → `^0.3.0`: `0.3.0` is the first `nodegraph-dispositions` release to stamp `owner` on the disposition edges it writes (Fathom row 5.0.139), and the 0.x caret doesn't admit the minor bump without this floor update.

### Changed

- `package.json` — `@kepello/nodegraph-dispositions` peer floor `^0.2.0` → `^0.3.0`.

### Tests

Suite unchanged: 45/45 pass. `npm run build` clean.

## [0.8.0] — 2026-07-16

**Fathom row 3.1.8.4, disposition-layer §S7 wave 4 (L5 scenarios slice) — the breaking wave.** The legacy membership edge family (`realizes`/`traverses` as raw edge TYPES, coexisting alongside `analysis-disposition` edges since wave 3a) is RETIRED. `analysis-disposition` edges are now THE membership record. Public API signatures unchanged. Design doc: [disposition-layer](../../planning/plans/design/disposition-layer.md) §S3/§S4/§S7 wave 4.

### Changed (breaking, pre-prod — delete `.fathom/graph.db` and re-analyze)

- `insertScenario` no longer emits `realizes`/`traverses`-typed edges — the old per-call realizes tombstone-on-drift block and the traverses target-identity dedup loop are gone. A new `reconcileDispositions` (mirrors `@kepello/nodegraph-clusters`'s `reconcileDispositionEdges` / `@kepello/nodegraph-domain-model`'s `reconcileDispositions`) brings the node's live `analysis-disposition` edges to exactly the `(target → kind set)` map computed from the current call's input on EVERY insert, re-insert, and supersede: a changed capability unit or a departed cluster tombstones its stale disposition edge outright, rather than accumulating live alongside the fresh one — DRIFT PARITY, the gap wave 3a's additive-only disposition writes left open (the legacy membership `realizes` edge already tombstoned a drifted target; the wave-3a disposition edges did not). Already-satisfied `(target, kinds)` pairs are skipped, so an identical re-insert stays churn-free (no new edge ids).
- `scenarioForUnit` / `realizesEdge` / `traversesEdges` re-implemented over `analysis-disposition` edges, filtering `metadata.kinds` CONTAINS the wanted kind — never `subtype` equality (per the frozen `PRIMARY_KIND_PRECEDENCE`, a merged edge's `subtype` names only the primary kind, not every kind it carries — though no L5 pair actually merges today, since `realizes` and `traverses` always target disjoint domains).
  - `scenarioForUnit`'s KNOWN TRAP: the `realizes` disposition edge ALWAYS carries a domain-prefixed `targetRef` (`capability-unit://<naturalKey>`), independent of whether the L2 unit node is materialized. Two distinct states are reachable and BOTH are now handled: RESOLVED — only when the unit node materializes/supersedes AFTER the scenario's disposition edge already exists, upgrading it to a real `targetId` via the substrate's cross-domain-URI exact match; DANGLING — the common case, including "unit already live before the scenario inserts" (no eager tail-match fires for a pure-hex, no-`#` ref at edge-insert time). Measured both states with dedicated fixtures rather than assuming which occurs.
  - `traversesEdges`' `subtype` no longer carries the stringified stepIndex (the legacy per-edge `subtype`) — it carries the disposition kind (`"traverses"`) like every other disposition edge. Callers needing step order/detail read the scenario node's `metadata.steps`, as before. Swept in-repo callers for subtype-as-stepIndex reliance: none found (only the retired test pin itself referenced it).

### Removed

- **`REALIZES_EDGE_TYPE` / `TRAVERSES_EDGE_TYPE`** — dead with the emission they named; no longer exported. Swept the workspace for importers: none found in-repo or in `fathom-cli`/`fathom-mcp` (the coincidentally-named `REALIZES_EDGE_TYPE` in `@kepello/nodegraph-use-cases` is a distinct, unrelated constant in a different package, already retired independently in that package's own wave-4 slice).

### Tests

45/45 pass (was 41; net +4 new, 6 reworked — SANCTIONED deltas, no silent deletions):

- New: a direct RED-witness pin that the legacy `realizes`/`traverses` edge TYPES are no longer emitted (every outgoing edge from a scenario node is `analysis-disposition`) · `scenarioForUnit`'s RESOLVED case (unit materializes after the scenario; disposition edge upgrades to `targetId`; findable both by the live unit's id and by its natural key) · two DRIFT PARITY regressions — a same-contentHash re-insert with a different `capabilityUnitId` tombstones the stale `realizes` disposition edge; a same-contentHash re-insert with a departed cluster tombstones the stale `traverses` disposition edge (both RED-witnessed against pre-wave-4 code via `git stash` of the implementation with the new tests applied — the old additive-only disposition write left both stale edges live forever, discovered as `staleEdge.lifecycleState === "live"` instead of `"tombstoned"`).
- Reworked (no assertions deleted, only retargeted at the new sole edge family): `insertScenario — persists metadata + realizes + traverses edges` now asserts `type === ANALYSIS_DISPOSITION_EDGE_TYPE` + `subtype`/`targetRef` shape (was: `type === REALIZES_EDGE_TYPE`); `scenarioForUnit — walks the realizes edge` renamed to name the DANGLING case explicitly; `traversesEdges — carry stepIndex in subtype` reworked to `subtype is the disposition kind, not a stepIndex` per the design's step-detail-in-metadata ruling; the three wave-3a coexistence pins (`insertScenario — additively emits…`, `…ALWAYS uses the domain-prefixed targetRef…`, `…traverses disposition edges are ONE per distinct cluster…`) dropped their membership-edge halves and now assert the disposition family directly via the public `realizesEdge`/`traversesEdges` API where the old assertions checked the membership edge.
- `npm run build` clean. Downstream (`fathom-cli`, `fathom-mcp`) rebuilt clean against this version; `fathom-cli`'s `analyze-abstractions.test.ts` and `fathom-mcp`'s scenario-touching suites re-run unaffected (4 pre-existing, unrelated `fathom-cli` L6 Factory-Method failures confirmed present identically on unmodified 0.7.1 via `git stash` — not caused by this change).

## [0.7.1] — 2026-07-16

Peer-floor sync, 3.1.8.4 wave 3a/3b sibling bumps — no code change. `@kepello/nodegraph-dispositions` peer floor `^0.1.0` → `^0.2.0` (0.x caret — did not admit the installed `0.2.0` without the bump).

### Tests

Suite unchanged: 41/41 pass. `npm run build` clean.

## [0.7.0] — 2026-07-16

Wave 3a of Fathom row `3.1.8.4` (the disposition layer) — L5's slice of the disposition-layer conversion. Design doc: [disposition-layer](../../planning/plans/design/disposition-layer.md) §S3/§S4/§S7 wave 3a. This is the biggest refusal population measured in wave 2's corpus run (**173 of 2,981** L5 closure edges on the home corpus — see wave-2's `[conservation-observe]` line). Two additive changes; no membership-edge behavior removed.

### Added

- **`insertScenario` additively emits `analysis-disposition` edges** alongside the existing membership edges (`@kepello/nodegraph-dispositions`'s `recordDispositions`, via this overlay's own `scenario`-domain mutator — the caller-mutator contract per that package's `DomainMismatchError` constraint):
  - `realizes` — scenario → L2 capability unit. **ALWAYS `targetRef`** in the `<domain>://<naturalKey>` cross-domain-URI form (`capability-unit://<unitId>`), independent of whether the membership `realizes` edge above it resolved to a real node id or stayed dangling. When `ScenarioInput.capabilityUnitId` IS a resolved node id, the disposition edge resolves through the node to its real `naturalKey` first — the disposition form is always the natural key, never a substrate UUID.
  - `traverses` — scenario → cluster, one edge per DISTINCT cluster in `traversedClusters`. Multiple steps landing in the same cluster still collapse to ONE disposition edge, exactly like the membership `traverses` edge already does under the substrate's `(source, target, type)` uniqueness index; step-level detail (stepIndex, source/target element, stereotype, layer) is never duplicated onto the disposition edge — it stays solely in the scenario node's `metadata.steps`.
- **`computeScenarios` returns structured `refusals`** (`ComputeScenariosResult.refusals: ScenarioRefusal[]`) — one entry per closure call edge skipped for want of a resolvable cluster endpoint, classifying the SAME `srcCluster === undefined || tgtCluster === undefined` skip condition into the design's two frozen L5 reasons, honestly distinguished by which operand failed (not an invented split):
  - `unclustered-container` — `edge.source` (always a member of the walking unit's own `entry ∪ owned` set — the element that CONTAINS the call site) has no cluster.
  - `no-cluster-endpoint` — `edge.source` resolved, but `edge.target` (the call's destination) has no cluster.
  - Checked `srcCluster` first so a single skipped edge — even one where BOTH endpoints are unclustered — contributes exactly one refusal, preserving the stage-ledger arithmetic (`IN = categorized + Σ refused + residual`) fathom-cli's wave-2 ledger already computes for L5.
  - `refusals` is always present, never absent (an empty array on a fully-resolved run) — no-silent-degradation.
  - `computeScenarios` stays graph-write-free: it RETURNS refusals, it does not record them. Wiring `refusals` through `recordRefusal` is wave 3b's job (`fathom-cli`, sequential).
- New peer dependency: `@kepello/nodegraph-dispositions@^0.1.0`.
- `ScenarioRefusal` / `ScenarioRefusalReason` exported from the package root.

### Tests

10 new tests (37 → 41, all in `overlay.test.ts` + `recovery.test.ts`), RED-witnessed first (targeted revert of each change, confirmed the specific new test failed for the predicted reason — `computeScenarios` reverted to pre-fix: 4/4 new refusal tests failed with `undefined` where `refusals` was expected; `overlay.ts` reverted: 4/4 new disposition tests failed with 0 edges found) before implementing, then reconfirmed green:

- `recovery.test.ts`: a call-target with no cluster returns `no-cluster-endpoint`; the unit's own owned element with no cluster returns `unclustered-container`; both endpoints unclustered on one edge produces exactly ONE refusal (source-side wins); a fully-resolved run returns `refusals: []`, never `undefined`; a conformance pin asserts both reason literals are byte-identical members of `@kepello/nodegraph-dispositions`'s frozen `REFUSAL_REASONS`.
- `overlay.test.ts`: the realizes disposition edge uses the domain-prefixed `targetRef` form both when the L2 unit is unmaterialized (mirrors the membership edge's dangling case) AND when it IS materialized (a case the membership edge resolves via `targetId`, but the disposition edge does not — this fixture caught a real bug in the first draft, which used the raw node id instead of resolving its `naturalKey`); traverses disposition edges collapse to one per distinct cluster across repeated-cluster steps, with step detail absent from the edge metadata; disposition edges don't duplicate across an idempotent re-insert.

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
