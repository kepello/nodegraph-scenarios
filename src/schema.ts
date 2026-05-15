/**
 * Scenario overlay domain + IndexSpecs + JSON Schema. Registered against
 * the substrate at overlay construction time. Mirrors the existing
 * capability-unit + cluster overlay shapes.
 */

import type { IndexSpec, MetadataSchema } from "@kepello/nodegraph-core";

export const SCENARIO_DOMAIN = "scenario";

export const SCENARIO_METADATA_KIND = "scenario";

export const SCENARIO_METADATA_SCHEMA: MetadataSchema = {
  type: "object",
  title: "Recovered scenario / flow",
  description:
    "The static trace of one L2 capability unit at cluster-to-cluster granularity. Steps ordered by source position (lexical approximation). Reads like a UML sequence diagram at cluster fidelity.",
  required: [
    "kind",
    "scenarioId",
    "capabilityUnitId",
    "entryElementId",
    "stepCount",
  ],
  properties: {
    kind: {
      type: "string",
      enum: ["scenario"],
      title: "Discriminator",
      description: "Always 'scenario' for nodes this overlay writes.",
    },
    scenarioId: {
      type: "string",
      title: "Stable scenario id",
      description:
        "Content-hash identity: `hash(capabilityUnitId || capabilityUnitContentHash)`. Regenerates when the underlying unit's closure changes.",
    },
    capabilityUnitId: {
      type: "string",
      title: "Source capability unit id",
      description: "The L2 unit this scenario realizes.",
    },
    entryElementId: {
      type: "string",
      title: "Entry element id",
      description: "Mirrors the unit's entry — duplicated for cheap index lookups.",
    },
    entryName: {
      type: "string",
      title: "Entry element name",
      description: "Local name of the entry, used as the scenario's display name.",
    },
    language: {
      type: "string",
      title: "Language",
      description:
        "Source language; set when the underlying capability unit is single-language; absent for mixed-language closures (not produced in v1).",
    },
    stepCount: {
      type: "number",
      title: "Inter-cluster step count",
      description:
        "Number of cluster-to-cluster transitions in the scenario. Zero for a unit whose closure stays inside one cluster.",
    },
    branchingPointCount: {
      type: "number",
      title: "Branching-point count",
      description:
        "Number of steps marked `isBranching: true` (dynamic-dispatch sites). Always 0 in v1 — wire protocol doesn't yet surface dispatch kind. Will become non-zero once Fathom l2-virtual-dispatch-protocol-extension (3.1.2.1) ships.",
    },
    steps: {
      type: "array",
      title: "Ordered transition steps",
      description:
        "Each step crosses a cluster boundary in lexical order: `{stepIndex, sourceCluster, targetCluster, sourceStereotype?, targetStereotype?, sourceLayer?, targetLayer?, isBranching, candidateTargetIds, sourceElementId, targetElementId, sourceLocation}`.",
    },
    traversedClusters: {
      type: "array",
      title: "Distinct clusters touched in step order",
      description:
        "De-duplicated sequence of cluster ids in the order they're first reached. Useful for cheap renderings without walking the full step list.",
    },
  },
};

export const SCENARIO_INDEXES: IndexSpec[] = [
  {
    name: "scenarios_by_scenario_id",
    fields: ["metadata.scenarioId"],
    scope: {
      domain: SCENARIO_DOMAIN,
      lifecycleState: "live",
      nonNull: ["metadata.scenarioId"],
    },
    unique: true,
  },
  {
    name: "scenarios_by_capability_unit",
    fields: ["metadata.capabilityUnitId"],
    scope: {
      domain: SCENARIO_DOMAIN,
      lifecycleState: "live",
      nonNull: ["metadata.capabilityUnitId"],
    },
  },
  {
    name: "scenarios_by_entry",
    fields: ["metadata.entryElementId"],
    scope: {
      domain: SCENARIO_DOMAIN,
      lifecycleState: "live",
      nonNull: ["metadata.entryElementId"],
    },
  },
  {
    name: "scenarios_by_language",
    fields: ["metadata.language"],
    scope: {
      domain: SCENARIO_DOMAIN,
      lifecycleState: "live",
      nonNull: ["metadata.language"],
    },
  },
];
