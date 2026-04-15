const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { readJson } = require("../src/validation/validator");
const { REPO_ROOT } = require("../src/validation/schema-registry");
const {
  RuntimeInterventionRunner,
  buildInterventionRetrievalRequest,
  composeInterventionQuery,
  normalizeInterventionText,
  truncateNormalizedText,
} = require("../src/runtime/intervention-runner");
const { FileBackedCatalog } = require("../src/storage/file-backed-catalog");
const { refreshSupportGraph } = require("../src/support-graph/refresh");
const { buildExampleCatalog } = require("./helpers/example-catalog");
const { loadExample } = require("./helpers/load-example");

test("runtime intervention baseline scenarios stay stable", async () => {
  const scenarios = readJson(`${REPO_ROOT}/benchmarks/runtime-intervention.baseline.json`);

  for (const scenario of scenarios) {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-intervention-baseline-"));
    const { catalogs, graphRoot } = prepareScenarioCatalog({
      rootDir,
      variant: scenario.catalog_variant,
    });
    const runner = new RuntimeInterventionRunner({
      graphRoot,
      artifactRoot: path.join(rootDir, ".local", "runtime-interventions"),
    });
    const result = await runner.run({
      intervention: scenario.intervention,
      catalogs,
      now: new Date("2026-05-01T00:00:00Z"),
    });
    const artifact = readJson(result.intervention.artifact_path);

    assert.equal(result.retrieval.plan.intent, scenario.expected.retrieval_intent, scenario.scenario_id);
    assert.deepEqual(result.intervention.selected_results, scenario.expected.selected_results, scenario.scenario_id);
    assert.equal(result.intervention.weak_hit, scenario.expected.weak_hit, scenario.scenario_id);
    assert.deepEqual(result.intervention.related_candidates, scenario.expected.related_candidates, scenario.scenario_id);
    assert.equal(artifact.retrieval_request.query, scenario.expected.query, scenario.scenario_id);
  }
});

test("failure_retry request composition is deterministic for failure kinds and normalized error text", () => {
  const moduleRequest = buildInterventionRetrievalRequest({
    intervention: {
      mode: "failure_retry",
      query: "debug the startup failure",
      project_scope: "project",
      failure_kind: "module_not_found",
      failure_text: truncateNormalizedText("Cannot find module ../qdrant-backend.js"),
    },
    now: new Date("2026-05-01T00:00:00Z"),
  });
  const envRequest = buildInterventionRetrievalRequest({
    intervention: {
      mode: "failure_retry",
      query: "debug the startup failure",
      project_scope: "project",
      failure_kind: "env_mismatch",
      failure_text: truncateNormalizedText("Expected ECITR_QDRANT_URL but got localhost:0"),
    },
    now: new Date("2026-05-01T00:00:00Z"),
  });
  const permissionRequest = buildInterventionRetrievalRequest({
    intervention: {
      mode: "failure_retry",
      query: "debug the startup failure",
      project_scope: "project",
      failure_kind: "permission_issue",
      failure_text: truncateNormalizedText("EACCES: permission denied, open '/tmp/ecitr.log'"),
    },
    now: new Date("2026-05-01T00:00:00Z"),
  });

  assert.equal(
    moduleRequest.query,
    "debug the startup failure module not found cannot find module ../qdrant-backend.js",
  );
  assert.equal(
    envRequest.query,
    "debug the startup failure env mismatch expected ecitr_qdrant_url but got localhost:0",
  );
  assert.equal(
    permissionRequest.query,
    "debug the startup failure permission issue eacces: permission denied open /tmp/ecitr.log",
  );
});

test("intervention normalizers preserve deterministic lower-case tokens and truncate long inputs", () => {
  assert.equal(
    normalizeInterventionText("EACCES: Permission denied, open '/tmp/ECITR.log'"),
    "eacces: permission denied open /tmp/ecitr.log",
  );
  assert.equal(
    composeInterventionQuery({
      mode: "failure_retry",
      query: "debug startup",
      failure_kind: "module_not_found",
      failure_text: truncateNormalizedText("Cannot find module ../qdrant-backend.js"),
    }),
    "debug startup module not found cannot find module ../qdrant-backend.js",
  );
  assert.equal(truncateNormalizedText("A".repeat(500)).length, 240);
});

test("weak-hit intervention succeeds without a support-graph snapshot", async () => {
  const runner = new RuntimeInterventionRunner({
    graphRoot: path.join(os.tmpdir(), `ecitr-missing-graph-${Date.now()}`),
    artifactRoot: path.join(os.tmpdir(), `ecitr-intervention-artifacts-${Date.now()}`),
  });

  const result = await runner.run({
    intervention: {
      mode: "preflight",
      query: "github.com/example/memory-engine/issues/42",
      project_scope: "project",
    },
    catalogs: buildWeakHitCatalog(),
    now: new Date("2026-05-01T00:00:00Z"),
  });

  assert.equal(result.intervention.weak_hit, true);
  assert.deepEqual(result.intervention.related_candidates, emptyResults());
});

test("graph-expanded intervention candidates must satisfy shared retrieval eligibility", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-intervention-eligibility-"));
  const { catalogs, graphRoot } = buildWeakHitGraphCatalog({ rootDir });
  const runner = new RuntimeInterventionRunner({
    graphRoot,
    artifactRoot: path.join(rootDir, ".local", "runtime-interventions"),
  });

  const result = await runner.run({
    intervention: {
      mode: "preflight",
      query: "github.com/example/memory-engine/issues/42",
      project_scope: "project",
    },
    catalogs,
    now: new Date("2026-05-01T00:00:00Z"),
  });

  assert.equal(result.intervention.weak_hit, true);
  assert.equal(result.intervention.summary.at(-1), "weak direct hit triggered support-graph expansion");
  assert.deepEqual(result.intervention.related_candidates, emptyResults());
});

test("stale support-graph snapshots disable intervention graph expansion", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-intervention-stale-"));
  const { catalogs, graphRoot } = buildWeakHitGraphCatalog({ rootDir });
  catalogs.tactics[0].revalidate_at = "2026-04-01T00:00:00Z";
  const runner = new RuntimeInterventionRunner({
    graphRoot,
    artifactRoot: path.join(rootDir, ".local", "runtime-interventions"),
  });

  const result = await runner.run({
    intervention: {
      mode: "preflight",
      query: "github.com/example/memory-engine/issues/42",
      project_scope: "project",
    },
    catalogs,
    now: new Date("2026-05-01T00:00:00Z"),
  });

  assert.equal(result.intervention.weak_hit, true);
  assert.equal(result.intervention.summary.at(-1), "weak direct hit with no support-graph expansion");
  assert.deepEqual(result.intervention.related_candidates, emptyResults());
});

test("intervention artifacts write outside the catalog and leave catalog counts unchanged", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-intervention-catalog-"));
  const catalog = new FileBackedCatalog({ rootDir });
  for (const recordType of [
    "evidence",
    "case",
    "invariant",
    "tactic",
    "atomic_claim_set",
    "parameter_definition",
    "parameter_observation",
  ]) {
    catalog.writeRecord(recordType, loadExample(recordType));
  }

  const beforeCounts = {
    evidence: catalog.countRecords("evidence"),
    case: catalog.countRecords("case"),
    invariant: catalog.countRecords("invariant"),
    tactic: catalog.countRecords("tactic"),
  };
  const runner = new RuntimeInterventionRunner({
    graphRoot: path.join(rootDir, ".local", "support-graph"),
    artifactRoot: path.join(rootDir, ".local", "runtime-interventions"),
  });

  const result = await runner.run({
    intervention: {
      mode: "preflight",
      query: "scope filter ranking project retrieval",
      project_scope: "project_family",
    },
    catalogs: catalog.loadRuntimeCatalogs(),
    now: new Date("2026-05-01T00:00:00Z"),
  });

  assert.match(result.intervention.artifact_path, /\.local\/runtime-interventions\/2026\/05\//);
  assert.deepEqual(
    {
      evidence: catalog.countRecords("evidence"),
      case: catalog.countRecords("case"),
      invariant: catalog.countRecords("invariant"),
      tactic: catalog.countRecords("tactic"),
    },
    beforeCounts,
  );
});

function prepareScenarioCatalog({ rootDir, variant }) {
  switch (variant) {
    case "example":
      return {
        catalogs: buildExampleCatalog(),
        graphRoot: path.join(rootDir, ".local", "support-graph"),
      };
    case "weak_hit_graph":
      return buildWeakHitGraphCatalog({ rootDir });
    case "wrong_scope_case_only":
      return {
        catalogs: buildWrongScopeCaseOnlyCatalog(),
        graphRoot: path.join(rootDir, ".local", "support-graph"),
      };
    default:
      throw new Error(`Unsupported intervention test catalog variant: ${variant}`);
  }
}

function buildWeakHitGraphCatalog({ rootDir }) {
  const catalog = new FileBackedCatalog({ rootDir });
  const catalogs = buildWeakHitCatalog();
  for (const record of catalogs.evidence) {
    catalog.writeRecord("evidence", record);
  }
  for (const record of catalogs.cases) {
    catalog.writeRecord("case", record);
  }
  for (const record of catalogs.invariants) {
    catalog.writeRecord("invariant", record);
  }
  for (const record of catalogs.tactics) {
    catalog.writeRecord("tactic", record);
  }
  for (const record of catalogs.atomic_claim_sets) {
    catalog.writeRecord("atomic_claim_set", record);
  }
  for (const record of catalogs.parameter_definitions) {
    catalog.writeRecord("parameter_definition", record);
  }
  for (const record of catalogs.parameter_observations) {
    catalog.writeRecord("parameter_observation", record);
  }

  const graphRoot = path.join(rootDir, ".local", "support-graph");
  refreshSupportGraph({
    catalogRoot: rootDir,
    graphRoot,
    builtAt: "2026-05-01T00:00:00.000Z",
  });

  return {
    catalogs: catalog.loadRuntimeCatalogs(),
    graphRoot,
  };
}

function buildWrongScopeCaseOnlyCatalog() {
  const caseRecord = structuredClone(loadExample("case"));
  caseRecord.context.project_scope = "project_family";

  return {
    tactics: [],
    invariants: [],
    cases: [caseRecord],
    evidence: [],
    atomic_claim_sets: [],
    parameter_definitions: [],
    parameter_observations: [],
    review_audit_entries: [],
  };
}

function buildWeakHitCatalog() {
  const caseRecord = structuredClone(loadExample("case"));
  const tacticRecord = structuredClone(loadExample("tactic"));

  caseRecord.context.project_scope = "project_family";
  tacticRecord.revalidate_at = "2026-01-01T00:00:00Z";

  return {
    tactics: [tacticRecord],
    invariants: [loadExample("invariant")],
    cases: [caseRecord],
    evidence: [loadExample("evidence")],
    atomic_claim_sets: [loadExample("atomic_claim_set")],
    parameter_definitions: [loadExample("parameter_definition")],
    parameter_observations: [loadExample("parameter_observation")],
    review_audit_entries: [],
  };
}

function emptyResults() {
  return {
    tactics: [],
    invariants: [],
    cases: [],
    evidence: [],
  };
}
