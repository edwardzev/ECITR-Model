const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { readJson } = require("../src/validation/validator");
const { REPO_ROOT } = require("../src/validation/schema-registry");
const { RetrievalRuntime } = require("../src/retrieval/runtime");
const { refreshSupportGraph } = require("../src/support-graph/refresh");
const { FileBackedCatalog } = require("../src/storage/file-backed-catalog");
const { loadExample } = require("./helpers/load-example");
const { buildExampleCatalog } = require("./helpers/example-catalog");

test("retrieval runtime returns grouped results from execution lanes", async () => {
  const runtime = new RetrievalRuntime();
  const catalogs = buildExampleCatalog();
  const request = {
    request_id: "req_runtime_default_001",
    query: "scope filter ranking project retrieval",
    workspace_id: "ecitr_model",
    project_scope: "project_family",
    intent: "analysis",
  };

  const { response } = await runtime.execute({ request, catalogs, now: new Date("2026-05-01T00:00:00Z") });

  assert.deepEqual(response.results.tactics, ["tac_metadata_prune_before_vector_rank_001"]);
  assert.deepEqual(response.results.invariants, ["inv_scope_filter_before_rank_001"]);
  assert.deepEqual(response.results.cases, ["case_retrieval_scope_drift_001"]);
  assert.deepEqual(response.results.evidence, ["ev_mem_20260410_001"]);
});

test("retrieval runtime excludes stale tactics and reports a conflict", async () => {
  const runtime = new RetrievalRuntime();
  const catalogs = buildExampleCatalog();
  catalogs.tactics[0].expiry_at = "2020-01-01T00:00:00Z";
  delete catalogs.tactics[0].revalidate_at;

  const request = {
    request_id: "req_runtime_stale_001",
    query: "scope filter ranking project retrieval",
    workspace_id: "ecitr_model",
    project_scope: "project_family",
    intent: "action",
  };

  const { response } = await runtime.execute({ request, catalogs, now: new Date("2026-05-01T00:00:00Z") });

  assert.deepEqual(response.results.tactics, []);
  assert.ok(response.conflicts.some((message) => message.includes("excluded tactic")));
});

test("retrieval runtime skips non-active cases before ranking", async () => {
  const runtime = new RetrievalRuntime();
  const catalogs = buildExampleCatalog();
  catalogs.cases[0].status = "draft";
  catalogs.cases[0].review_state = "draft";

  const request = {
    request_id: "req_runtime_draft_case_001",
    query: "scope filter ranking project retrieval",
    workspace_id: "ecitr_model",
    project_scope: "project_family",
    intent: "analysis",
  };

  const { response } = await runtime.execute({ request, catalogs, now: new Date("2026-05-01T00:00:00Z") });
  assert.deepEqual(response.results.cases, []);
});

test("retrieval runtime can surface evidence through atomic-claim semantic text", async () => {
  const runtime = new RetrievalRuntime();
  const catalogs = buildExampleCatalog();
  const request = {
    request_id: "req_runtime_semantic_001",
    query: "unauthorized candidates affect result set",
    workspace_id: "ecitr_model",
    project_scope: "global",
    intent: "analysis",
    allowed_layers: ["evidence"],
    max_results_per_layer: {
      evidence: 3,
    },
  };

  const { response } = await runtime.execute({ request, catalogs, now: new Date("2026-05-01T00:00:00Z") });

  assert.deepEqual(response.results.evidence, ["ev_mem_20260410_001"]);
});

test("retrieval runtime can surface parameter-linked evidence, cases, and tactics without a new top-level layer", async () => {
  const runtime = new RetrievalRuntime();
  const catalogs = buildExampleCatalog();
  const request = {
    request_id: "req_runtime_parameter_001",
    query: "ECITR_QDRANT_URL",
    workspace_id: "ecitr_model",
    project_scope: "project_family",
    intent: "analysis",
  };

  const { response } = await runtime.execute({ request, catalogs, now: new Date("2026-05-01T00:00:00Z") });

  assert.ok(response.results.tactics.includes("tac_metadata_prune_before_vector_rank_001"));
  assert.ok(response.results.cases.includes("case_retrieval_scope_drift_001"));
  assert.ok(response.results.evidence.includes("ev_mem_20260410_001"));
});

test("retrieval runtime excludes parameterized case hits when the parameter observation is superseded", async () => {
  const runtime = new RetrievalRuntime();
  const catalogs = buildExampleCatalog();
  catalogs.cases[0].parameter_observation_refs = ["paramobs_stale_case_parameter"];
  catalogs.parameter_definitions = [
    ...catalogs.parameter_definitions,
    {
      definition_id: "paramdef_stale_case_parameter",
      observed_key: "SERVICE_URL",
      normalized_key: "service_url",
      value_type: "string",
      created_at: "2026-04-10T11:00:00Z",
      first_observed_at: "2026-04-10T11:00:00Z",
      first_source_evidence_ref: "ev_mem_20260410_001",
    },
  ];
  catalogs.parameter_observations = [
    ...catalogs.parameter_observations,
    {
      observation_id: "paramobs_stale_case_parameter",
      definition_id: "paramdef_stale_case_parameter",
      parameter_key: "SERVICE_URL",
      raw_value_text: "http://stale.local",
      value_type: "string",
      value_json: "http://stale.local",
      observation_kind: "set",
      observed_at: "2026-04-10T11:00:00Z",
      project_scope: "project_family",
      source_evidence_refs: ["ev_mem_20260410_001"],
      source_spans: [
        {
          path: "config.service.url",
          start_line: 1,
          end_line: 1,
          start_char: 0,
          end_char: 29,
          quote: "SERVICE_URL=http://stale.local",
        },
      ],
      strategy_id: "parameter-distiller-file-v1",
      extracted_at: "2026-04-10T11:00:00Z",
      extracted_by: "parameter-distiller",
      confidence: 0.9,
    },
    {
      observation_id: "paramobs_current_case_parameter",
      definition_id: "paramdef_stale_case_parameter",
      parameter_key: "SERVICE_URL",
      raw_value_text: "http://current.local",
      value_type: "string",
      value_json: "http://current.local",
      observation_kind: "set",
      observed_at: "2026-04-10T11:05:00Z",
      project_scope: "project_family",
      source_evidence_refs: ["ev_mem_20260410_001"],
      source_spans: [
        {
          path: "config.service.url",
          start_line: 2,
          end_line: 2,
          start_char: 0,
          end_char: 31,
          quote: "SERVICE_URL=http://current.local",
        },
      ],
      strategy_id: "parameter-distiller-file-v1",
      extracted_at: "2026-04-10T11:05:00Z",
      extracted_by: "parameter-distiller",
      confidence: 0.9,
      supersedes: "paramobs_stale_case_parameter",
    },
  ];

  const request = {
    request_id: "req_runtime_parameter_002",
    query: "http://stale.local",
    workspace_id: "ecitr_model",
    project_scope: "project_family",
    intent: "analysis",
  };

  const { response } = await runtime.execute({ request, catalogs, now: new Date("2026-05-01T00:00:00Z") });
  assert.deepEqual(response.results.cases, []);
});

test("retrieval runtime excludes wrong-scope parameterized evidence and cases", async () => {
  const runtime = new RetrievalRuntime();
  const catalogs = buildExampleCatalog();
  catalogs.cases[0].context.project_scope = "project";
  catalogs.evidence[0].project_scope = "project";

  const request = {
    request_id: "req_runtime_parameter_scope_001",
    query: "ECITR_QDRANT_URL",
    workspace_id: "ecitr_model",
    project_scope: "project_family",
    intent: "analysis",
    allowed_layers: ["cases", "evidence"],
    max_results_per_layer: {
      cases: 3,
      evidence: 3,
    },
  };

  const { response } = await runtime.execute({ request, catalogs, now: new Date("2026-05-01T00:00:00Z") });
  assert.deepEqual(response.results.cases, []);
  assert.deepEqual(response.results.evidence, []);
});

test("retrieval runtime can surface imported run evidence through payload-derived text", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-runtime-run-"));
  const catalog = new FileBackedCatalog({ rootDir: tempRoot });
  const payloadRef = "payloads/evidence/agent-ops/runs/2026/04/ev_aops_run_test_001.json";
  const payloadPath = path.join(tempRoot, payloadRef);

  fs.mkdirSync(path.dirname(payloadPath), { recursive: true });
  fs.writeFileSync(payloadPath, `${JSON.stringify({
    id: "run_test_001",
    project_id: "agent_ops",
    objective: "Harden the ECITR local Qdrant operation path and rerun the semantic benchmark.",
    findings: [
      "The managed runtime is healthy on http://127.0.0.1:6333.",
    ],
    next_actions: [
      "Rerun the managed benchmark after sync.",
    ],
  }, null, 2)}\n`);

  catalog.writeRecord("evidence", {
    evidence_id: "ev_aops_run_test_001",
    workspace_id: "ecitr_model",
    substrate_ref: "file:///tmp/run_test_001.json",
    source_type: "file",
    source_locator: "/tmp/run_test_001.json",
    captured_at: "2026-04-10T17:34:34.209Z",
    project_scope: "project",
    actor_scope: "mixed",
    verbatim_payload_ref: payloadRef,
    payload_hash: "sha256:test",
    source_hash: "sha256:test",
    redaction_state: "none",
    immutable: true,
  });

  const runtime = new RetrievalRuntime();
  const catalogs = catalog.loadRuntimeCatalogs();
  const request = {
    request_id: "req_runtime_payload_run_001",
    query: "managed qdrant benchmark operation path",
    workspace_id: "ecitr_model",
    project_scope: "project",
    intent: "analysis",
    allowed_layers: ["evidence"],
    max_results_per_layer: {
      evidence: 3,
    },
  };

  const { response } = await runtime.execute({ request, catalogs, now: new Date("2026-05-01T00:00:00Z") });
  assert.deepEqual(response.results.evidence, ["ev_aops_run_test_001"]);
});

test("retrieval runtime excludes records from a different workspace before ranking", async () => {
  const runtime = new RetrievalRuntime();
  const catalogs = buildExampleCatalog();
  catalogs.tactics[0].workspace_id = "workspace_other";
  catalogs.invariants[0].workspace_id = "workspace_other";
  catalogs.cases[0].workspace_id = "workspace_other";
  catalogs.evidence[0].workspace_id = "workspace_other";

  const request = {
    request_id: "req_runtime_workspace_001",
    query: "scope filter ranking project retrieval",
    workspace_id: "ecitr_model",
    project_scope: "project_family",
    intent: "analysis",
  };

  const { response } = await runtime.execute({ request, catalogs, now: new Date("2026-05-01T00:00:00Z") });

  assert.deepEqual(response.results.tactics, []);
  assert.deepEqual(response.results.invariants, []);
  assert.deepEqual(response.results.cases, []);
  assert.deepEqual(response.results.evidence, []);
  assert.ok(response.conflicts.some((message) => message.includes("workspace")));
});

test("retrieval runtime can surface imported session evidence through payload-derived text", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-runtime-session-"));
  const catalog = new FileBackedCatalog({ rootDir: tempRoot });
  const payloadRef = "payloads/evidence/agent-ops/sessions/2026/04/ev_aops_session_test_001.json";
  const payloadPath = path.join(tempRoot, payloadRef);

  fs.mkdirSync(path.dirname(payloadPath), { recursive: true });
  fs.writeFileSync(payloadPath, `${JSON.stringify({
    id: "session_test_001",
    project_id: "agent_ops",
    query: "Harden the ECITR local Qdrant operation path and update docs.",
    status: "closed",
    closure_notes: "Verified managed local Qdrant lifecycle commands and benchmark behavior.",
  }, null, 2)}\n`);

  catalog.writeRecord("evidence", {
    evidence_id: "ev_aops_session_test_001",
    workspace_id: "ecitr_model",
    substrate_ref: "file:///tmp/session_test_001.json",
    source_type: "file",
    source_locator: "/tmp/session_test_001.json",
    captured_at: "2026-04-10T17:34:34.211Z",
    project_scope: "project",
    actor_scope: "mixed",
    verbatim_payload_ref: payloadRef,
    payload_hash: "sha256:test",
    source_hash: "sha256:test",
    redaction_state: "none",
    immutable: true,
  });

  const runtime = new RetrievalRuntime();
  const catalogs = catalog.loadRuntimeCatalogs();
  const request = {
    request_id: "req_runtime_payload_session_001",
    query: "verified managed local qdrant lifecycle benchmark behavior",
    workspace_id: "ecitr_model",
    project_scope: "project",
    intent: "analysis",
    allowed_layers: ["evidence"],
    max_results_per_layer: {
      evidence: 3,
    },
  };

  const { response } = await runtime.execute({ request, catalogs, now: new Date("2026-05-01T00:00:00Z") });
  assert.deepEqual(response.results.evidence, ["ev_aops_session_test_001"]);
});

test("fresh support-graph explanations do not change retrieval results or ordering", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-runtime-graph-fresh-"));
  const graphRoot = path.join(rootDir, ".local", "support-graph");
  const catalog = materializeExampleCatalog(rootDir);
  refreshSupportGraph({
    catalogRoot: rootDir,
    graphRoot,
    builtAt: "2026-05-01T00:00:00.000Z",
  });

  const request = {
    request_id: "req_runtime_graph_explanations_001",
    query: "scope filter ranking project retrieval",
    project_scope: "project_family",
    intent: "analysis",
  };
  const catalogs = catalog.loadRuntimeCatalogs();
  const baselineRuntime = new RetrievalRuntime({ responseEnricher: null });
  const enrichedRuntime = new RetrievalRuntime({ graphRoot });

  const { response: baselineResponse } = await baselineRuntime.execute({
    request,
    catalogs,
    now: new Date("2026-05-01T00:00:00Z"),
  });
  const { response: enrichedResponse } = await enrichedRuntime.execute({
    request,
    catalogs,
    now: new Date("2026-05-01T00:00:00Z"),
  });

  assert.deepEqual(enrichedResponse.results, baselineResponse.results);
  assert.equal(enrichedResponse.explanations.length, baselineResponse.explanations.length + 4);
  assert.ok(enrichedResponse.explanations.some((line) =>
    line.includes("graph support: tactic tac_metadata_prune_before_vector_rank_001 linked to case case_retrieval_scope_drift_001")));
  assert.ok(enrichedResponse.explanations.some((line) =>
    line.includes("graph support: evidence ev_mem_20260410_001 linked to source artifact")));
});

test("stale support-graph snapshots are ignored during explanation enrichment", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-runtime-graph-stale-"));
  const graphRoot = path.join(rootDir, ".local", "support-graph");
  const catalog = materializeExampleCatalog(rootDir);
  refreshSupportGraph({
    catalogRoot: rootDir,
    graphRoot,
    builtAt: "2026-05-01T00:00:00.000Z",
  });

  const catalogs = catalog.loadRuntimeCatalogs();
  catalogs.tactics[0].revalidate_at = "2026-08-01T00:00:00Z";
  const request = {
    request_id: "req_runtime_graph_stale_001",
    query: "scope filter ranking project retrieval",
    project_scope: "project_family",
    intent: "analysis",
  };
  const runtime = new RetrievalRuntime({ graphRoot });
  const { response } = await runtime.execute({
    request,
    catalogs,
    now: new Date("2026-05-01T00:00:00Z"),
  });

  assert.equal(
    response.explanations.filter((line) => line.startsWith("graph support:")).length,
    0,
  );
});

test("retrieval runtime abstains on exact and natural nonsense with compact diagnostics", async () => {
  const runtime = new RetrievalRuntime({ responseEnricher: null });
  for (const [index, query] of [
    "zzzxqv_nonexistent_74291",
    "snargle",
    "scopebanana",
  ].entries()) {
    const { response } = await runtime.execute({
      request: {
        request_id: `req_runtime_abstain_${index}`,
        query,
        workspace_id: "ecitr_model",
        project_scope: "project_family",
        intent: "analysis",
      },
      catalogs: buildExampleCatalog(),
      now: new Date("2026-05-01T00:00:00Z"),
    });

    assert.deepEqual(response.results, {
      tactics: [],
      invariants: [],
      cases: [],
      evidence: [],
    });
    assert.ok(response.explanations.some((line) => line.includes("retrieval abstained")));
    assert.ok(response.conflicts.length <= 7);
    assert.ok(JSON.stringify(response).length < 8_000);
  }
});

test("exact identifier queries reject semantic-only candidates without direct support", async () => {
  const catalogs = buildExampleCatalog();
  const unrelatedInvariant = catalogs.invariants[0];
  const runtime = new RetrievalRuntime({
    responseEnricher: null,
    lanesFactory() {
      return [{
        async execute() {
          return [{
            recordId: unrelatedInvariant.id,
            layer: "invariants",
            laneId: "semantic",
            score: 0.99,
            record: unrelatedInvariant,
            reasons: ["uncorroborated semantic hit"],
          }];
        },
      }];
    },
  });

  const { response } = await runtime.execute({
    request: {
      request_id: "req_runtime_identifier_guard_001",
      query: "ECITR_PROMOTION_JUDGE_MODEL",
      workspace_id: "ecitr_model",
      project_scope: "project_family",
      intent: "analysis",
    },
    catalogs,
    now: new Date("2026-05-01T00:00:00Z"),
  });

  assert.deepEqual(response.results.invariants, []);
  assert.ok(response.conflicts.some((line) =>
    line.includes("exact identifier queries require lexical or metadata support")));
});

test("retrieval runtime keeps one evidence result per source lineage", async () => {
  const catalogs = buildExampleCatalog();
  const baseEvidence = catalogs.evidence[0];
  catalogs.evidence = [0, 1, 2].map((index) => ({
    ...structuredClone(baseEvidence),
    evidence_id: `ev_shared_chat_snapshot_${index}`,
    source_type: "chat",
    source_locator: "codex-thread://shared-memory-topic",
    substrate_ref: `codex-thread://shared-memory-topic#snapshot-${index}`,
    verbatim_payload_ref: `payloads/evidence/shared-memory-topic-${index}.json`,
    captured_at: `2026-04-10T12:0${index}:00.000Z`,
  }));
  const runtime = new RetrievalRuntime({ responseEnricher: null });
  const request = {
    request_id: "req_runtime_lineage_default_001",
    query: "shared-memory-topic",
    workspace_id: "ecitr_model",
    project_scope: "project_family",
    intent: "analysis",
    allowed_layers: ["evidence"],
    max_results_per_layer: { evidence: 3 },
  };

  const { response } = await runtime.execute({
    request,
    catalogs,
    now: new Date("2026-05-01T00:00:00Z"),
  });

  assert.equal(response.results.evidence.length, 1);
  assert.equal(response.results.evidence[0], "ev_shared_chat_snapshot_2");
});

test("retrieval runtime caps public conflict diagnostics", async () => {
  const catalogs = buildExampleCatalog();
  const candidates = Array.from({ length: 40 }, (_, index) => {
    const record = {
      ...structuredClone(catalogs.evidence[0]),
      evidence_id: `ev_wrong_workspace_${String(index).padStart(2, "0")}`,
      workspace_id: "workspace_other",
    };
    return {
      recordId: record.evidence_id,
      layer: "evidence",
      laneId: "semantic",
      score: 1,
      record,
      reasons: ["test candidate"],
      semanticQualified: true,
    };
  });
  const runtime = new RetrievalRuntime({
    responseEnricher: null,
    lanesFactory() {
      return [{
        async execute() {
          return candidates;
        },
      }];
    },
  });

  const { response } = await runtime.execute({
    request: {
      request_id: "req_runtime_conflict_cap_001",
      query: "workspace conflict",
      workspace_id: "ecitr_model",
      project_scope: "project_family",
      intent: "analysis",
    },
    catalogs,
    now: new Date("2026-05-01T00:00:00Z"),
  });

  assert.equal(response.conflicts.length, 7);
  assert.match(response.conflicts.at(-1), /^suppressed 34 additional retrieval exclusion/);
  assert.equal(response.conflicts.at(-1).includes("workspace_conflict=40"), true);
  assert.equal(response.__fusionDiagnostics, undefined);
});

test("graph explanations stay fresh when retrieval filters corrected evidence", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-runtime-graph-correction-"));
  const graphRoot = path.join(rootDir, ".local", "support-graph");
  const catalog = materializeExampleCatalog(rootDir);
  const original = catalog.getRecord("evidence", "ev_mem_20260410_001");
  catalog.writeRecord("evidence", {
    ...original,
    evidence_id: "ev_mem_20260410_001_corrected",
    correction_of: original.evidence_id,
  });
  refreshSupportGraph({
    catalogRoot: rootDir,
    graphRoot,
    builtAt: "2026-05-01T00:00:00.000Z",
  });

  const request = {
    request_id: "req_runtime_graph_correction_001",
    query: "scope filter ranking project retrieval",
    project_scope: "project_family",
    intent: "analysis",
  };
  const catalogs = catalog.loadRuntimeCatalogs();
  const baselineRuntime = new RetrievalRuntime({ responseEnricher: null });
  const enrichedRuntime = new RetrievalRuntime({ graphRoot });
  const { response: baseline } = await baselineRuntime.execute({
    request,
    catalogs,
    now: new Date("2026-05-01T00:00:00Z"),
  });
  const { response: enriched } = await enrichedRuntime.execute({
    request,
    catalogs,
    now: new Date("2026-05-01T00:00:00Z"),
  });

  assert.deepEqual(enriched.results, baseline.results);
  assert.ok(enriched.results.evidence.includes("ev_mem_20260410_001_corrected"));
  assert.ok(!enriched.results.evidence.includes("ev_mem_20260410_001"));
  assert.ok(enriched.explanations.some((line) => line.startsWith("graph support:")));
});

test("retrieval runtime baseline scenarios stay stable", async () => {
  const runtime = new RetrievalRuntime();
  const catalogs = buildExampleCatalog();
  const baselinePath = `${REPO_ROOT}/benchmarks/retrieval-runtime.baseline.json`;
  const scenarios = readJson(baselinePath);

  for (const scenario of scenarios) {
    const { response } = await runtime.execute({
      request: scenario.request,
      catalogs: buildExampleCatalog(),
      now: new Date("2026-05-01T00:00:00Z"),
    });

    assert.deepEqual(response.results, scenario.expected.results, `baseline mismatch for ${scenario.scenario_id}`);
  }
});

test("retrieval runtime executes lanes in parallel", async () => {
  let releaseFirstLane;
  const firstLaneReady = new Promise((resolve) => {
    releaseFirstLane = resolve;
  });
  const events = [];
  const runtime = new RetrievalRuntime({
    planner: {
      plan() {
        return {
          allowed_layers: [],
          max_results_per_layer: {
            tactics: 0,
            invariants: 0,
            cases: 0,
            evidence: 0,
          },
          require_evidence: false,
        };
      },
    },
    lanesFactory() {
      return [
        {
          async execute() {
            events.push("lane-1-start");
            await firstLaneReady;
            events.push("lane-1-end");
            return [];
          },
        },
        {
          async execute() {
            events.push("lane-2-start");
            releaseFirstLane();
            events.push("lane-2-end");
            return [];
          },
        },
      ];
    },
  });

  const outcome = await Promise.race([
    runtime.execute({
      request: {
        request_id: "req_runtime_parallel_001",
        query: "parallel lanes",
        project_scope: "global",
        intent: "analysis",
      },
      catalogs: buildExampleCatalog(),
      now: new Date("2026-05-01T00:00:00Z"),
    }).then(() => "completed"),
    new Promise((resolve) => setTimeout(() => resolve("timed_out"), 100)),
  ]);

  assert.equal(outcome, "completed");
  assert.deepEqual(events.slice(0, 2), ["lane-1-start", "lane-2-start"]);
});

function materializeExampleCatalog(rootDir) {
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

  return catalog;
}
