/**
 * Scenario overlay implementation. Registers the `"scenario"` domain
 * idempotently at construction time.
 *
 * Fathom row 3.1.8.4 wave 4 (the disposition layer's "breaking wave"):
 * `analysis-disposition` edges ARE the membership record. The legacy
 * `realizes` / `traverses` MEMBERSHIP edge family (plain edge `type`
 * literals, wave 3a's additive coexistence) is RETIRED — pre-prod, no
 * migration path, no dual-emission (`AGENTS.md` "no migration paths").
 * Writes:
 *
 *   - `analysis-disposition` edge, kind `realizes` — scenario → L2
 *     capability unit (one per scenario). ALWAYS `targetRef` in the
 *     `<domain>://<naturalKey>` cross-domain-URI form
 *     (`capability-unit://<unitId>`), independent of whether the unit
 *     node is materialized — see "targetRef pattern" below.
 *   - `analysis-disposition` edges, kind `traverses` — scenario →
 *     cluster touched, one per DISTINCT cluster in
 *     `input.traversedClusters` (already deduplicated by the caller —
 *     see `ComputedScenario.traversedClusters`'s doc comment). Multiple
 *     steps landing in the same cluster still collapse to ONE
 *     disposition edge; step-level detail (stepIndex, source/target
 *     element, stereotype, layer) is NEVER duplicated onto the
 *     disposition edge — it stays solely in the scenario node's
 *     `metadata.steps`.
 *
 * Both kinds are RECONCILED on every insert/re-insert/supersede —
 * `reconcileDispositions` below tombstones any live disposition edge
 * whose target fell out of the CURRENT desired set (a changed capability
 * unit, or a cluster the scenario no longer traverses) before emitting
 * the desired set fresh. INVARIANT: live disposition edges == current
 * membership, always. This closes the drift-parity gap wave 3a left
 * open: the old membership `realizes` edge explicitly tombstoned a
 * drifted target; wave 3a's ADDITIVE-only disposition edges did not.
 * Mirrors `@kepello/nodegraph-clusters`'s `reconcileDispositionEdges` /
 * `@kepello/nodegraph-domain-model`'s `reconcileDispositions`.
 *
 * `capability-unit`'s domain string is a local literal, not imported
 * from `@kepello/nodegraph-capability-units` — this package has never
 * taken a runtime dependency on that sibling (see `UnitInput`'s doc
 * comment in `recovery.ts`: structural typing only), and a bare string
 * constant is the smallest change consistent with that.
 *
 * -----------------------------------------------------------------------
 * `realizes` targetRef pattern — query-time structured targets
 * -----------------------------------------------------------------------
 *
 * The `realizes`-kind disposition edge points from a scenario node to
 * its L2 capability unit, ALWAYS as:
 *
 *   insertEdge({ sourceId, targetRef: `capability-unit://${unitNaturalKey}`, ... })
 *
 * where `unitNaturalKey` is the L2 unit's NATURAL KEY — a pure-hex
 * content hash (e.g. `"bfe93b294554316c"`), never a substrate node id.
 * This is the "query-time structured target" pattern:
 *
 *   - `targetRef` = `capability-unit://<unit natural key>` (a cross-domain URI).
 *   - Resolution happens at QUERY TIME via `queryEdges({ targetRef })`.
 *   - The substrate MUST NOT eagerly tail-resolve pure-hex `targetRef` values —
 *     hex strings are maximally ambiguous across domains, and tail-matching
 *     against a naturalKey index that spans all domains would silently produce
 *     wrong matches or false positives. (The substrate's cross-domain-URI
 *     EXACT match still fires when the unit node materializes/supersedes
 *     AFTER this edge exists — `resolveDanglingEdgesFor`'s mode 2 — so a
 *     `realizes` disposition edge CAN end up resolved to `targetId`; see
 *     `scenarioForUnit` below for how reads handle both outcomes.)
 *
 * Consumers MUST use one of:
 *   1. `graph.queryEdges({ targetRef: "capability-unit://" + unitNaturalKey,
 *      type: "analysis-disposition" })`, filtering `metadata.kinds` for
 *      `"realizes"` (never `subtype` equality — a merged edge's primary
 *      kind can differ from a kind it still carries).
 *   2. `ScenarioOverlay.scenarioForUnit(capabilityUnitId)` — implements (1)
 *      plus the resolved-edge case.
 *   3. `ScenarioOverlay.realizesEdge(scenarioId)` — for the outgoing direction.
 *
 * Consumers MUST NOT treat a dangling `realizes` disposition edge as data
 * loss — it is the expected steady state for a not-yet-materialized L2 unit.
 * -----------------------------------------------------------------------
 */

import type { Edge, GraphLayer, GraphMutator, Node } from "@kepello/nodegraph-core";
import {
  ANALYSIS_DISPOSITION_EDGE_TYPE,
  makeDispositionOverlay,
  type DispositionCandidate,
  type DispositionOverlay,
  type PositiveKind,
} from "@kepello/nodegraph-dispositions";
import {
  SCENARIO_DOMAIN,
  SCENARIO_INDEXES,
  SCENARIO_METADATA_KIND,
  SCENARIO_METADATA_SCHEMA,
  SCENARIO_SCHEMA_VERSION,
} from "./schema.js";
import {
  type ScenarioInput,
  type ScenarioMetadata,
  type ScenarioNode,
  type ScenarioOverlay,
} from "./types.js";

/** Local literal — see the module doc comment's "capability-unit's domain string" note. */
const CAPABILITY_UNIT_DOMAIN = "capability-unit";

export class ScenarioOverlayImpl implements ScenarioOverlay {
  private readonly mutator: GraphMutator<typeof SCENARIO_DOMAIN>;
  private readonly dispositionOverlay: DispositionOverlay;

  constructor(private readonly graph: GraphLayer) {
    // Per Fathom row 5.0.42: registerOverlay returns the domain-scoped mutator.
    this.mutator = this.graph.registerOverlay({
        domain: SCENARIO_DOMAIN,
        schemaVersion: SCENARIO_SCHEMA_VERSION,
        metadataSchema: SCENARIO_METADATA_SCHEMA,
        indexes: SCENARIO_INDEXES,
      });
    // Fathom row 3.1.8.4 wave 3a — `recordDispositions` edges are
    // sourced in THIS overlay's own `scenario` domain (never
    // `disposition`'s), so `this.mutator` above is what gets passed to
    // it; see `@kepello/nodegraph-dispositions`'s overlay.ts doc comment
    // for the `DomainMismatchError` constraint that forces this shape.
    this.dispositionOverlay = makeDispositionOverlay(this.graph);
  }

  insertScenario(input: ScenarioInput): ScenarioNode {
    return this.graph.transaction(
      {
        kind: "insert-scenario",
        producerDomain: SCENARIO_DOMAIN,
        summary: `insert scenario ${input.scenarioId}`,
      },
      () => this.doInsertScenario(input),
    ).result;
  }

  private doInsertScenario(input: ScenarioInput): ScenarioNode {
    const metadata = buildMetadata(input);
    const existing = this.graph.getLiveNodeByNaturalKey(
      SCENARIO_DOMAIN,
      input.scenarioId,
    );
    let node: Node;
    if (existing === undefined) {
      node = this.mutator.insertNode({
        domain: SCENARIO_DOMAIN,
        naturalKey: input.scenarioId,
        contentHash: input.contentHash,
        metadata: metadata as unknown,
      });
    } else if (existing.contentHash === input.contentHash) {
      node = existing;
    } else {
      node = this.mutator.supersedeNode(existing.id, {
        contentHash: input.contentHash,
        metadata: metadata as unknown,
      });
    }

    // Fathom row 3.1.8.4 wave 4 — `analysis-disposition` edges ARE the
    // membership record now (module doc comment; the legacy plain
    // `realizes`/`traverses` edge TYPE family retired this wave).
    //
    // `input.capabilityUnitId` may be EITHER the unit's natural key
    // (content hash — the common cold-analysis case) OR an already-
    // resolved node id. The disposition edge's `domain://naturalKey`
    // form always needs the REAL natural key — resolve through the node
    // when `capabilityUnitId` turns out to be an id, else it already IS
    // the natural key.
    const capabilityUnitById = this.graph.getNodeById(input.capabilityUnitId);
    const capabilityUnitNaturalKey =
      capabilityUnitById !== undefined ? capabilityUnitById.naturalKey : input.capabilityUnitId;
    const realizesTargetRef = `${CAPABILITY_UNIT_DOMAIN}://${capabilityUnitNaturalKey}`;

    const wanted = new Map<string, Set<PositiveKind>>();
    wanted.set(realizesTargetRef, new Set<PositiveKind>(["realizes"]));
    for (const clusterId of input.traversedClusters) {
      let kinds = wanted.get(clusterId);
      if (kinds === undefined) {
        kinds = new Set<PositiveKind>();
        wanted.set(clusterId, kinds);
      }
      kinds.add("traverses");
    }
    this.reconcileDispositions(node.id, wanted);

    return asScenario(node);
  }

  /**
   * Bring the scenario node's outgoing `analysis-disposition` edges to
   * EXACTLY `wanted` (target key → kind set) — Fathom row 3.1.8.4 wave 4
   * DRIFT PARITY. Mirrors `@kepello/nodegraph-clusters`'s
   * `reconcileDispositionEdges` / `@kepello/nodegraph-domain-model`'s
   * `reconcileDispositions`. A target whose kind set changed, or that
   * fell out of `wanted` entirely (a changed capability unit; a cluster
   * the scenario no longer traverses), is tombstoned and re-emitted
   * fresh — `recordDispositions`' kind merge is deliberately ADDITIVE
   * (correct within one call), so stale-kind accumulation across
   * re-inserts would be THIS overlay's bug, not the package's.
   * Already-satisfied pairs are skipped entirely — `recordDispositions`
   * supersedes unconditionally on existing pairs, and re-sending
   * identical state every re-analyze would churn edge ids for nothing.
   *
   * Note `supersedeNode` (the different-contentHash `doInsertScenario`
   * branch) already cascade-tombstones the prior tip's own outgoing
   * edges, so `existing` below is empty on that path and every `wanted`
   * pair is freshly emitted. The reconcile logic still matters on the
   * identical-contentHash / SAME-node path (`node = existing`), where no
   * cascade fires and a caller-supplied change (e.g. `capabilityUnitId`)
   * would otherwise leave a stale disposition edge live forever.
   */
  private reconcileDispositions(
    nodeId: string,
    wanted: ReadonlyMap<string, ReadonlySet<PositiveKind>>,
  ): void {
    const existing = this.graph.edgesFrom(nodeId, {
      type: ANALYSIS_DISPOSITION_EDGE_TYPE,
      includeDangling: true,
    });
    const satisfied = new Set<string>();
    for (const e of existing) {
      const key = e.targetId ?? e.targetRef;
      if (key === null) continue;
      const wantedKinds = wanted.get(key);
      if (wantedKinds !== undefined && kindSetEquals(edgeKinds(e), wantedKinds)) {
        satisfied.add(key);
        continue;
      }
      // Stale target (drift) or stale kind set — tombstone; wanted pairs
      // re-emit fresh below.
      this.mutator.tombstoneEdge(e.id);
    }
    const batch: DispositionCandidate[] = [];
    for (const [target, kinds] of wanted) {
      if (satisfied.has(target)) continue;
      // Same target resolution the write side always used: resolved
      // node id when the target names a live node, dangling targetRef
      // otherwise. For the realizes target this is always dangling —
      // `target` is the `capability-unit://<naturalKey>` URI string,
      // which `getNodeById` never resolves to a real node.
      const resolved = this.graph.getNodeById(target) !== undefined;
      for (const kind of kinds) {
        batch.push(
          resolved
            ? { sourceId: nodeId, targetId: target, kind }
            : { sourceId: nodeId, targetRef: target, kind },
        );
      }
    }
    if (batch.length > 0) {
      this.dispositionOverlay.recordDispositions(this.mutator, batch);
    }
  }

  tombstoneScenario(scenarioId: string): void {
    this.graph.transaction(
      {
        kind: "tombstone-scenario",
        producerDomain: SCENARIO_DOMAIN,
        summary: `tombstone scenario ${scenarioId}`,
      },
      () => {
        const existing = this.graph.getLiveNodeByNaturalKey(
          SCENARIO_DOMAIN,
          scenarioId,
        );
        if (existing === undefined) return;
        this.mutator.tombstoneNode(existing.id);
      },
    );
  }

  listScenarios(): ScenarioNode[] {
    return this.graph
      .queryNodes({ domain: SCENARIO_DOMAIN, lifecycleState: "live" })
      .map(asScenario);
  }

  getScenario(scenarioId: string): ScenarioNode | undefined {
    const node = this.graph.getLiveNodeByNaturalKey(SCENARIO_DOMAIN, scenarioId);
    return node === undefined ? undefined : asScenario(node);
  }

  scenarioForUnit(capabilityUnitId: string): ScenarioNode | undefined {
    // Fathom row 3.1.8.4 wave 4 — reads over `analysis-disposition`
    // edges, kind `realizes`. THE KNOWN TRAP (module doc's "targetRef
    // pattern"): the disposition `realizes` edge is ALWAYS written with
    // a domain-prefixed `targetRef`, so two genuinely different states
    // must both be handled:
    //
    //   - RESOLVED — reachable ONLY when the unit node materializes
    //     (insertNode/supersedeNode) AFTER this scenario's disposition
    //     edge already exists; the substrate's dangling-resolution
    //     mechanism (`resolveDanglingEdgesFor`'s cross-domain-URI exact
    //     match) upgrades the edge to a real `targetId`. Reachable via
    //     `edgesTo` ONLY when `capabilityUnitId` itself names that live
    //     node (i.e. is a resolved id, not a bare natural key).
    //   - DANGLING — the common case, including "unit materialized
    //     BEFORE the scenario" (no eager tail-match fires for a pure-hex,
    //     no-`#` domain-prefixed ref at edge-insert time — see the
    //     module doc). Reachable only by querying the EXACT
    //     domain-prefixed `targetRef` string, never the raw id/naturalKey.
    //
    // Both are checked unconditionally (not either/or) — measured
    // behavior, not assumed: a caller could pass either form (a resolved
    // node id OR the unit's bare natural key — real callers pass the
    // natural key, per `@kepello/nodegraph-capability-units`'s
    // `getUnit`/wire convention), and which state the edge is actually
    // in depends on analyze ordering this overlay doesn't control. Try
    // BOTH interpretations of `capabilityUnitId` to find the live unit
    // node (if any) — a natural key lookup after a direct id lookup, not
    // either/or — so the RESOLVED-edge branch is checked whichever form
    // the caller supplied.
    const unitNode =
      this.graph.getNodeById(capabilityUnitId) ??
      this.graph.getLiveNodeByNaturalKey(CAPABILITY_UNIT_DOMAIN, capabilityUnitId);
    const unitNaturalKey = unitNode !== undefined ? unitNode.naturalKey : capabilityUnitId;
    const targetRef = `${CAPABILITY_UNIT_DOMAIN}://${unitNaturalKey}`;

    const candidates: Edge[] = [];
    if (unitNode !== undefined) {
      candidates.push(
        ...this.graph.edgesTo(unitNode.id, { type: ANALYSIS_DISPOSITION_EDGE_TYPE }),
      );
    }
    candidates.push(
      ...this.graph.queryEdges({
        targetRef,
        type: ANALYSIS_DISPOSITION_EDGE_TYPE,
        lifecycleState: "live",
      }),
    );

    for (const edge of candidates) {
      if (!hasKind(edge, "realizes")) continue;
      const node = this.graph.getNodeById(edge.sourceId);
      if (
        node !== undefined &&
        node.lifecycleState === "live" &&
        node.domain === SCENARIO_DOMAIN
      ) {
        return asScenario(node);
      }
    }
    return undefined;
  }

  /** Outgoing `analysis-disposition` edge, kind `realizes` — exactly one per scenario. */
  realizesEdge(scenarioId: string): Edge | undefined {
    const node = this.graph.getLiveNodeByNaturalKey(SCENARIO_DOMAIN, scenarioId);
    if (node === undefined) return undefined;
    const edges = this.graph.edgesFrom(node.id, {
      type: ANALYSIS_DISPOSITION_EDGE_TYPE,
      includeDangling: true,
    });
    return edges.find((e) => hasKind(e, "realizes"));
  }

  /** Outgoing `analysis-disposition` edges, kind `traverses` — one per distinct cluster touched. */
  traversesEdges(scenarioId: string): Edge[] {
    const node = this.graph.getLiveNodeByNaturalKey(SCENARIO_DOMAIN, scenarioId);
    if (node === undefined) return [];
    return this.graph
      .edgesFrom(node.id, {
        type: ANALYSIS_DISPOSITION_EDGE_TYPE,
        includeDangling: true,
      })
      .filter((e) => hasKind(e, "traverses"));
  }
}

function buildMetadata(input: ScenarioInput): ScenarioMetadata {
  let branchingPointCount = 0;
  for (const step of input.steps) {
    if (step.isBranching) branchingPointCount += 1;
  }
  const meta: ScenarioMetadata = {
    kind: SCENARIO_METADATA_KIND,
    scenarioId: input.scenarioId,
    capabilityUnitId: input.capabilityUnitId,
    entryElementId: input.entryElementId,
    entryName: input.entryName,
    stepCount: input.steps.length,
    branchingPointCount,
    steps: [...input.steps],
    traversedClusters: [...input.traversedClusters],
  };
  if (input.language !== undefined) meta.language = input.language;
  return meta;
}

function asScenario(node: Node): ScenarioNode {
  return node as ScenarioNode;
}

/**
 * True when `edge.metadata.kinds` (the `analysis-disposition` edge's
 * merged kind set) contains `kind`. Per module doc + READ SEMANTICS:
 * NEVER `subtype` equality — `subtype` is only the PRIMARY kind by
 * precedence, and a merged edge can carry a kind that isn't primary.
 * Mirrors `@kepello/nodegraph-domain-model`'s `edgeKinds`/kind-set helpers.
 */
function hasKind(edge: Edge, kind: PositiveKind): boolean {
  return edgeKinds(edge).includes(kind);
}

/** Kinds carried on an `analysis-disposition` edge (`metadata.kinds`). */
function edgeKinds(edge: Edge): PositiveKind[] {
  const metadata = edge.metadata;
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) return [];
  const kinds = (metadata as Record<string, unknown>).kinds;
  return Array.isArray(kinds) ? (kinds as PositiveKind[]) : [];
}

function kindSetEquals(
  kinds: readonly PositiveKind[],
  wanted: ReadonlySet<PositiveKind>,
): boolean {
  if (kinds.length !== wanted.size) return false;
  for (const k of kinds) {
    if (!wanted.has(k)) return false;
  }
  return true;
}

export function makeScenarioOverlay(graph: GraphLayer): ScenarioOverlay {
  return new ScenarioOverlayImpl(graph);
}
