const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { readJson } = require("../src/validation/validator");
const { REPO_ROOT } = require("../src/validation/schema-registry");
const { RetrievalRuntime } = require("../src/retrieval/runtime");
const { FileBackedCatalog } = require("../src/storage/file-backed-catalog");
const { buildExampleCatalog } = require("./helpers/example-catalog");

test("retrieval runtime returns grouped results from execution lanes", async () => {
  const runtime = new RetrievalRuntime();
  const catalogs = buildExampleCatalog();
  const request = {
    request_id: "req_runtime_default_001",
    query: "scope filter ranking project retrieval",
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
