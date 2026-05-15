# @kepello/nodegraph-scenarios

Scenario / flow recovery for [`@kepello/nodegraph`](https://github.com/kepello/nodegraph-core). Fifth layer of the Layered Code Abstraction arc (L5 in [Fathom's roadmap](https://github.com/kepello/Fathom/blob/main/docs/code_abstraction.md#l5--scenario--flow-recovery)).

Each scenario is the static trace of one L2 capability unit — what happens, at cluster-to-cluster granularity, when its entry point is invoked. Steps are ordered by source position (lexical approximation; branches and loops flattened to textual order). Reads like a UML sequence diagram at cluster fidelity.

## Quick start

```ts
import { computeScenarios, makeScenarioOverlay } from "@kepello/nodegraph-scenarios";

const result = computeScenarios({
  units: [
    {
      unitId: "u1",
      entryElementId: "createUser",
      entryName: "createUser",
      contentHash: "ch1",
      ownedElementIds: ["validate"],
      usedElementIds: ["logActivity"],
    },
  ],
  callEdges: [
    { source: "createUser", target: "validate", sourceLine: 5 },
    { source: "createUser", target: "logActivity", sourceLine: 8 },
  ],
  clusterByElement: new Map([
    ["createUser", "cluster-controllers"],
    ["validate", "cluster-domain"],
    ["logActivity", "cluster-telemetry"],
  ]),
});

for (const scenario of result.scenarios) {
  // Each step crosses cluster boundaries:
  //   step 0: controllers → domain   (createUser → validate at line 5)
  //   step 1: controllers → telemetry (createUser → logActivity at line 8)
}
```

## Surface

- `computeScenarios({ units, callEdges, clusterByElement, stereotypeByElement?, layerByCluster? })` — pure algorithm: for each L2 unit, walks the closure's call edges in lexical source-position order, projects each call to source/target cluster pairs, and emits one `TransitionStep` per inter-cluster boundary. Intra-cluster sequences collapse to nothing.
- `computeScenarioId(capabilityUnitId, capabilityUnitContentHash)` — stable content-hash identity helper.
- `makeScenarioOverlay(graph)` — registers the `"scenario"` domain + indexes; exposes write / read API (`insertScenario`, `listScenarios`, `getScenario`, `scenarioForUnit`).

## Trade-offs

- **Lexical-order ordering** flattens branches and loops to textual order. Real control-flow ordering needs the wire protocol to surface per-method CFG (parked as Fathom `l5-cfg-walk-extension` 3.1.5.1).
- **Dynamic dispatch treated as direct calls** — `isBranching` is always `false` in v1 because the wire protocol doesn't surface dispatch kind. Real branching-marker support lands alongside Fathom `l2-virtual-dispatch-protocol-extension` (3.1.2.1).
- **Cross-language scenarios unsupported** — no cross-language calls in the L0 graph, so scenarios stay per-language.
- **No output-driven slicing** in v1 (parked as Fathom `l5-slicing-extension` 3.1.5.2).
