const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { OrchestratorExecutionLoop } = require("../src/orchestrator/execution-loop");
const { HashSemanticEmbedder } = require("../src/retrieval/embedders/hash-embedder");
const { SemanticRetrievalBackend } = require("../src/retrieval/semantic-backend-interface");
const { readJson } = require("../src/validation/validator");
const { FileBackedCatalog } = require("../src/storage/file-backed-catalog");
const { writeLanceDbCatalogBasis } = require("../src/retrieval/semantic-backends/lancedb-backend");
const { loadEcitrProjectConfig } = require("../src/workspace/config");
const {
  createProjectMemoryRetrievalRuntime,
  localLanceDbTableExists,
  ProjectMemorySurface,
  summarizeMemoryInvocations,
} = require("../src/runtime/project-memory");
const { loadExample } = require("./helpers/load-example");
const { buildExampleCatalog } = require("./helpers/example-catalog");
const { parseArgs: parseMemoryReportArgs } = require("../src/cli/report-memory-invocations");
const { parseArgs: parseMemoryOpportunityArgs } = require("../src/cli/log-memory-opportunity");
const { parseArgs: parseMemoryUsageArgs } = require("../src/cli/record-memory-usage");
const { parseArgs: parseMemorySearchArgs } = require("../src/cli/search-project-memory");

test("execution loop exposes project memory in plain sight and logs no-consult opportunities", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-project-memory-opportunity-"));
  const catalogRoot = path.join(rootDir, ".local", "catalog");
  seedWorkspaceMarker({ rootDir, defaultProjectScope: "project_family" });
  const catalog = materializeExampleCatalog(catalogRoot);
  const loop = new OrchestratorExecutionLoop({ catalog });

  const result = await loop.run({
    taskPacket: loadExample("orchestrator_task_packet"),
    now: new Date("2026-05-01T00:00:00Z"),
  });

  assert.equal(result.memory_surface.available, true);
  assert.equal(result.memory_surface.tool_name, "search_project_memory");
  assert.equal(result.memory_surface.usage_tool_name, "record_memory_usage");
  assert.equal(result.memory_surface.workspace_id, "ecitr_model");
  assert.equal(result.memory_surface.default_project_scope, "project_family");
  assert.equal(result.memory_invocation.memory_consulted, false);
  assert.equal(result.memory_invocation.consult_trigger, null);
  assert.ok(result.next_actions.includes("project memory available via search_project_memory"));

  const artifact = readJson(result.memory_invocation.artifact_path);
  assert.equal(artifact.memory_available, true);
  assert.equal(artifact.memory_consulted, false);
  assert.equal(artifact.workspace_id, "ecitr_model");
  assert.equal(artifact.default_project_scope, "project_family");
});

test("search_project_memory uses workspace defaults and records discretionary consultation metrics", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-project-memory-search-"));
  const catalogRoot = path.join(rootDir, ".local", "catalog");
  seedWorkspaceMarker({ rootDir, defaultProjectScope: "project_family" });
  const catalog = materializeExampleCatalog(catalogRoot);
  const loop = new OrchestratorExecutionLoop({ catalog });

  const result = await loop.search_project_memory({
    query: "scope filter ranking project retrieval",
    taskPacket: loadExample("orchestrator_task_packet"),
    now: new Date("2026-05-01T00:00:00Z"),
  });

  assert.equal(result.memory_surface.available, true);
  assert.equal(result.memory_invocation.memory_consulted, true);
  assert.equal(result.memory_invocation.consult_trigger, "discretionary");
  assert.equal(result.memory_invocation.returned_counts.tactics, 1);
  assert.equal(result.memory_invocation.returned_counts.cases, 1);
  assert.equal(result.retrieval.response.results.tactics[0], "tac_metadata_prune_before_vector_rank_001");
  assert.equal(result.retrieval.response.results.cases[0], "case_retrieval_scope_drift_001");
  assert.equal(result.retrieval_gate.mode, "shadow");
  assert.equal(result.retrieval_gate.enforcement, "disabled");
  assert.equal(result.retrieval_gate.actual_behavior, "retrieve_always");

  const artifact = readJson(result.memory_invocation.artifact_path);
  assert.equal(artifact.request.workspace_id, "ecitr_model");
  assert.equal(artifact.request.project_scope, "project_family");
  assert.equal(artifact.request.intent, "analysis");
  assert.equal(artifact.retrieval_gate.gate_id, "ecitr-conservative-shadow-v1");
  assert.deepEqual(artifact.returned_record_ids.tactics, ["tac_metadata_prune_before_vector_rank_001"]);
});

test("a shadow skip proposal cannot suppress project-memory retrieval", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-project-memory-shadow-gate-"));
  const catalogRoot = path.join(rootDir, ".local", "catalog");
  seedWorkspaceMarker({ rootDir, defaultProjectScope: "project_family" });
  const catalog = materializeExampleCatalog(catalogRoot);
  const projectConfig = loadEcitrProjectConfig({ startDir: rootDir });
  let retrievalCalls = 0;
  const retrievalRuntime = {
    async execute({ request }) {
      retrievalCalls += 1;
      return {
        plan: { request_id: request.request_id },
        response: {
          results: { tactics: [], invariants: [], cases: [], evidence: [] },
        },
      };
    },
  };
  const surface = new ProjectMemorySurface({
    catalog,
    projectConfig,
    retrievalRuntime,
  });

  const result = await surface.searchProjectMemory({
    query: "What is computer memory?",
    taskPacket: loadExample("orchestrator_task_packet"),
    now: new Date("2026-05-01T00:00:00Z"),
  });

  assert.equal(result.retrieval_gate.proposed_decision, "skip");
  assert.equal(result.retrieval_gate.decision, "skip");
  assert.equal(result.retrieval_gate.actual_behavior, "retrieve_always");
  assert.equal(retrievalCalls, 1);
  assert.ok(result.retrieval);
});

test("record_memory_usage marks when returned memory was actually used", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-project-memory-usage-"));
  const catalogRoot = path.join(rootDir, ".local", "catalog");
  seedWorkspaceMarker({ rootDir, defaultProjectScope: "project_family" });
  const catalog = materializeExampleCatalog(catalogRoot);
  const loop = new OrchestratorExecutionLoop({ catalog });

  const search = await loop.searchProjectMemory({
    query: "scope filter ranking project retrieval",
    taskPacket: loadExample("orchestrator_task_packet"),
    now: new Date("2026-05-01T00:00:00Z"),
  });

  const usage = loop.record_memory_usage({
    invocationId: search.memory_invocation.invocation_id,
    usedRecordIds: [
      "tac_metadata_prune_before_vector_rank_001",
      "case_retrieval_scope_drift_001",
      "non_returned_record",
    ],
    selectedRecordIds: ["tac_metadata_prune_before_vector_rank_001"],
    now: new Date("2026-05-01T00:03:00Z"),
  });

  assert.equal(usage.used_memory, true);
  assert.deepEqual(usage.used_returned_record_ids, [
    "case_retrieval_scope_drift_001",
    "tac_metadata_prune_before_vector_rank_001",
  ]);
  assert.deepEqual(usage.selected_record_ids, ["tac_metadata_prune_before_vector_rank_001"]);

  const artifact = readJson(usage.artifact_path);
  assert.equal(artifact.used_memory, true);
  assert.deepEqual(artifact.used_returned_record_ids, usage.used_returned_record_ids);
  assert.equal(artifact.usage_recorded_at, "2026-05-01T00:03:00.000Z");
});

test("invocation reporting measures opportunities, triggers, returns, and actual use", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-project-memory-report-"));
  const catalogRoot = path.join(rootDir, ".local", "catalog");
  seedWorkspaceMarker({ rootDir, defaultProjectScope: "project_family" });
  const catalog = materializeExampleCatalog(catalogRoot);
  const projectConfig = loadEcitrProjectConfig({ startDir: rootDir });
  const surface = new ProjectMemorySurface({
    catalog,
    projectConfig,
    retrievalRuntime: createProjectMemoryRetrievalRuntime({
      responseEnricher: null,
    }),
  });

  surface.logTaskOpportunity({
    taskPacket: {
      task_id: "task_no_consult",
      title: "No consultation",
    },
    now: new Date("2026-05-01T00:00:00Z"),
  });
  const search = await surface.searchProjectMemory({
    query: "scope filter ranking project retrieval",
    taskPacket: {
      task_id: "task_preflight",
      title: "Preflight consultation",
    },
    trigger: "preflight",
    now: new Date("2026-05-01T00:01:00Z"),
  });
  surface.recordMemoryUsage({
    invocationId: search.memory_invocation.invocation_id,
    usedRecordIds: ["case_retrieval_scope_drift_001"],
    now: new Date("2026-05-01T00:02:00Z"),
  });

  const report = summarizeMemoryInvocations({
    artifactRoot: surface.artifactRoot,
  });

  assert.equal(report.task_opportunities, 2);
  assert.equal(report.consultations, 1);
  assert.equal(report.consultation_rate, 0.5);
  assert.equal(report.consultations_by_trigger.preflight, 1);
  assert.equal(report.consultations_with_results, 1);
  assert.equal(report.usage_callbacks, 1);
  assert.equal(report.used_memory, 1);
  assert.equal(report.used_memory_rate, 1);
});

test("project memory runtime uses LanceDB semantic backend when the local table exists", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-project-memory-lancedb-"));
  const catalogRoot = path.join(rootDir, ".local", "catalog");
  seedWorkspaceMarker({ rootDir, defaultProjectScope: "project_family" });
  const catalog = materializeExampleCatalog(catalogRoot);
  const calls = [];
  const retrievalRuntime = createProjectMemoryRetrievalRuntime({
    tableExists() {
      return true;
    },
    buildEmbedder() {
      return {
        async embedQuery() {
          return { dense: [0.1], sparse: { indices: [0], values: [1] } };
        },
        async embedDocuments() {
          return [];
        },
      };
    },
    buildLanceDbBackend({ catalogs }) {
      calls.push("lancedb");
      return new FixedSemanticBackend({
        record: catalogs.evidence[0],
        layer: "evidence",
        recordId: catalogs.evidence[0].evidence_id,
        reason: "test lancedb semantic backend",
      });
    },
    buildFallbackBackend() {
      calls.push("fallback");
      return new FixedSemanticBackend({ candidates: [] });
    },
  });
  const loop = new OrchestratorExecutionLoop({ catalog, retrievalRuntime });

  const result = await loop.search_project_memory({
    query: "force local semantic backend",
    taskPacket: loadExample("orchestrator_task_packet"),
    allowedLayers: ["evidence"],
    maxResultsPerLayer: { evidence: 1 },
    now: new Date("2026-05-01T00:00:00Z"),
  });

  assert.deepEqual(calls, ["lancedb"]);
  assert.deepEqual(result.retrieval.response.results.evidence, [catalog.loadRuntimeCatalogs().evidence[0].evidence_id]);
});

test("project memory validates a correction-rich LanceDB basis but returns only the current leaf", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-project-memory-corrections-"));
  const catalogRoot = path.join(rootDir, ".local", "catalog");
  const lancedbUri = path.join(rootDir, ".local", "lancedb");
  const tableName = "semantic_records";
  seedWorkspaceMarker({ rootDir, defaultProjectScope: "project_family" });
  const catalog = materializeExampleCatalog(catalogRoot);
  const parent = catalog.listRecords("evidence")[0];
  const correction = {
    ...parent,
    evidence_id: `${parent.evidence_id}_correction`,
    correction_of: parent.evidence_id,
  };
  catalog.writeRecord("evidence", correction);
  const canonicalCatalogs = catalog.loadRuntimeCatalogs();
  const embedder = new HashSemanticEmbedder();
  fs.mkdirSync(path.join(lancedbUri, `${tableName}.lance`), { recursive: true });
  writeLanceDbCatalogBasis({
    uri: lancedbUri,
    tableName,
    catalogs: canonicalCatalogs,
    embeddingSignature: embedder.embeddingSignature,
  });

  const calls = [];
  let backendEvidenceIds = [];
  const retrievalRuntime = createProjectMemoryRetrievalRuntime({
    lancedbUri,
    lancedbTableName: tableName,
    responseEnricher: null,
    buildEmbedder() {
      return embedder;
    },
    buildLanceDbBackend({ catalogs }) {
      calls.push("lancedb");
      backendEvidenceIds = catalogs.evidence.map((record) => record.evidence_id);
      return new FixedSemanticBackend({
        record: correction,
        layer: "evidence",
        recordId: correction.evidence_id,
        reason: "current correction leaf from current LanceDB basis",
      });
    },
    buildFallbackBackend() {
      calls.push("fallback");
      return new FixedSemanticBackend({ candidates: [] });
    },
  });
  const loop = new OrchestratorExecutionLoop({ catalog, retrievalRuntime });

  const result = await loop.search_project_memory({
    query: "scope filter ranking project retrieval",
    taskPacket: loadExample("orchestrator_task_packet"),
    allowedLayers: ["evidence"],
    maxResultsPerLayer: { evidence: 1 },
    now: new Date("2026-05-01T00:00:00Z"),
  });

  assert.deepEqual(calls, ["lancedb"]);
  assert.ok(backendEvidenceIds.includes(parent.evidence_id));
  assert.ok(backendEvidenceIds.includes(correction.evidence_id));
  assert.deepEqual(result.retrieval.response.results.evidence, [correction.evidence_id]);
  assert.ok(!result.retrieval.response.results.evidence.includes(parent.evidence_id));
});

test("project memory runtime falls back when no LanceDB table exists", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-project-memory-fallback-"));
  const catalogRoot = path.join(rootDir, ".local", "catalog");
  seedWorkspaceMarker({ rootDir, defaultProjectScope: "project_family" });
  const catalog = materializeExampleCatalog(catalogRoot);
  const calls = [];
  const retrievalRuntime = createProjectMemoryRetrievalRuntime({
    tableExists() {
      return false;
    },
    buildLanceDbBackend() {
      calls.push("lancedb");
      return new FixedSemanticBackend({ candidates: [] });
    },
    buildFallbackBackend({ catalogs }) {
      calls.push("fallback");
      return new FixedSemanticBackend({
        record: catalogs.cases[0],
        layer: "cases",
        recordId: catalogs.cases[0].case_id,
        reason: "test fallback semantic backend",
      });
    },
  });
  const loop = new OrchestratorExecutionLoop({ catalog, retrievalRuntime });

  const result = await loop.search_project_memory({
    query: "force fallback backend",
    taskPacket: loadExample("orchestrator_task_packet"),
    allowedLayers: ["cases"],
    maxResultsPerLayer: { cases: 1 },
    now: new Date("2026-05-01T00:00:00Z"),
  });

  assert.deepEqual(calls, ["fallback"]);
  assert.deepEqual(result.retrieval.response.results.cases, [catalog.loadRuntimeCatalogs().cases[0].case_id]);
});

test("local LanceDB table detection is path based and local only", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-project-memory-table-"));
  const otherCatalogRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-project-memory-other-catalog-"));
  const tableName = "semantic_records";

  assert.equal(localLanceDbTableExists({ uri: rootDir, tableName }), false);
  fs.mkdirSync(path.join(rootDir, `${tableName}.lance`), { recursive: true });
  assert.equal(localLanceDbTableExists({ uri: rootDir, tableName }), true);

  const catalogs = buildExampleCatalog();
  writeLanceDbCatalogBasis({
    uri: rootDir,
    tableName,
    catalogs,
    embeddingSignature: "hash:16:2048",
  });
  assert.equal(localLanceDbTableExists({
    uri: rootDir,
    tableName,
    catalogs,
    expectedEmbeddingSignature: () => "hash:16:2048",
  }), true);
  catalogs.invariants[0].status = "deprecated";
  assert.equal(localLanceDbTableExists({
    uri: rootDir,
    tableName,
    catalogs,
    expectedEmbeddingSignature: () => "hash:16:2048",
  }), false);

  assert.equal(localLanceDbTableExists({
    uri: rootDir,
    tableName,
    catalogRoot: otherCatalogRoot,
    constrainDefaultUriToDefaultCatalog: true,
  }), false);
  assert.equal(localLanceDbTableExists({ uri: "https://example.test/lancedb", tableName }), false);
});

test("project memory rejects a LanceDB basis built with the pre-Unicode hash signature", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-project-memory-tokenizer-basis-"));
  const tableName = "semantic_records";
  const catalogs = buildExampleCatalog();
  const currentSignature = new HashSemanticEmbedder().embeddingSignature;
  fs.mkdirSync(path.join(rootDir, `${tableName}.lance`), { recursive: true });
  writeLanceDbCatalogBasis({
    uri: rootDir,
    tableName,
    catalogs,
    embeddingSignature: "hash:16:2048",
  });

  assert.equal(localLanceDbTableExists({
    uri: rootDir,
    tableName,
    catalogs,
    expectedEmbeddingSignature: () => currentSignature,
  }), false);

  writeLanceDbCatalogBasis({
    uri: rootDir,
    tableName,
    catalogs,
    embeddingSignature: currentSignature,
  });
  assert.equal(localLanceDbTableExists({
    uri: rootDir,
    tableName,
    catalogs,
    expectedEmbeddingSignature: () => currentSignature,
  }), true);
});

test("project-memory CLIs default to the marked current workspace", () => {
  const cwd = process.cwd();

  assert.equal(parseMemoryReportArgs([]).workspaceRoot, cwd);
  assert.equal(parseMemoryOpportunityArgs([
    "--task-id",
    "task_001",
    "--task-title",
    "Inspect memory",
  ]).workspaceRoot, cwd);
  assert.equal(parseMemoryUsageArgs([
    "--invocation-id",
    "meminv_001",
  ]).workspaceRoot, cwd);
  assert.equal(parseMemorySearchArgs([
    "--query",
    "scope filter",
  ]).workspaceRoot, cwd);
});

function materializeExampleCatalog(rootDir) {
  const catalog = new FileBackedCatalog({ rootDir });

  for (const recordType of [
    "evidence",
    "case",
    "invariant",
    "tactic",
    "atomic_claim_set",
  ]) {
    catalog.writeRecord(recordType, loadExample(recordType));
  }

  return catalog;
}

function seedWorkspaceMarker({ rootDir, defaultProjectScope }) {
  const marker = {
    ...loadExample("ecitr_project"),
    default_project_scope: defaultProjectScope,
  };
  fs.writeFileSync(
    path.join(rootDir, "ecitr.project.json"),
    `${JSON.stringify(marker, null, 2)}\n`,
    "utf8",
  );
}

class FixedSemanticBackend extends SemanticRetrievalBackend {
  constructor({ candidates, record, layer, recordId, reason } = {}) {
    super({
      backendId: "fixed-project-memory-test-backend",
      capabilities: ["test"],
    });
    this.candidates = candidates ?? [
      {
        recordId,
        layer,
        laneId: "semantic",
        score: 1,
        record,
        reasons: [reason],
        semanticQualified: true,
      },
    ];
  }

  async retrieve() {
    return this.candidates;
  }
}
