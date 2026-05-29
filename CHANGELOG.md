# Changelog

All notable changes to `@kepello/nodegraph-scenarios`. Format follows [Keep a Changelog](https://keepachangelog.com/).

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
