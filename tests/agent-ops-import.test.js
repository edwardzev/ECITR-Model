const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  importAgentOpsRuns,
  buildEvidenceId,
  RUNS_RELATIVE_ROOT,
} = require("../src/importers/agent-ops-runs");
const { FileBackedCatalog } = require("../src/storage/file-backed-catalog");
const { CaseSeedStore, buildCaseSeedId } = require("../src/cases/case-seed-store");
const { createSha256 } = require("../src/evidence/file-payload-store");

test("agent-ops runs importer dry-run maps runs without writing catalog state", () => {
  const { agentOpsRoot, catalogRoot, runFilePath } = createImportFixture();

  const result = importAgentOpsRuns({
    agentOpsRoot,
    catalogRoot,
    dryRun: true,
  });

  assert.equal(result.dry_run, true);
  assert.equal(result.scanned_files, 2);
  assert.equal(result.candidate_runs, 2);
  assert.equal(result.planned, 2);
  assert.deepEqual(result.planned_evidence_ids.sort(), [
    buildEvidenceId("run_20260410173434_mcp"),
    buildEvidenceId("run_20260410173435_other"),
  ].sort());
  assert.equal(result.imported, 0);
  assert.equal(result.conflicts, 0);
  assert.equal(result.errors, 0);
  assert.equal(result.sample_results[0].evidence_id, buildEvidenceId("run_20260410173434_mcp"));
  assert.match(result.sample_results[0].verbatim_payload_ref, /^payloads\/evidence\/agent-ops\/runs\/2026\/04\//);
  assert.equal(fs.existsSync(path.join(catalogRoot, "evidence")), false);
  assert.equal(fs.existsSync(path.join(catalogRoot, "payloads")), false);
  assert.ok(fs.existsSync(runFilePath));
});

test("agent-ops runs importer writes evidence records and payload copies", () => {
  const { agentOpsRoot, catalogRoot, runFilePath } = createImportFixture();

  const firstPass = importAgentOpsRuns({
    agentOpsRoot,
    catalogRoot,
    projectId: "agent_ops",
    dryRun: false,
  });

  assert.equal(firstPass.imported, 1);
  assert.equal(firstPass.skipped_existing, 0);
  assert.equal(firstPass.errors, 0);

  const catalog = new FileBackedCatalog({ rootDir: catalogRoot });
  const evidenceId = buildEvidenceId("run_20260410173434_mcp");
  const record = catalog.getRecord("evidence", evidenceId);
  const sourceBytes = fs.readFileSync(runFilePath);
  const payloadPath = path.join(catalogRoot, ...record.verbatim_payload_ref.split("/"));

  assert.equal(record.evidence_id, evidenceId);
  assert.equal(record.source_locator, path.resolve(runFilePath));
  assert.equal(record.source_hash, createSha256(sourceBytes));
  assert.equal(record.payload_hash, createSha256(sourceBytes));
  assert.equal(fs.readFileSync(payloadPath, "utf8"), sourceBytes.toString("utf8"));

  const secondPass = importAgentOpsRuns({
    agentOpsRoot,
    catalogRoot,
    projectId: "agent_ops",
    dryRun: false,
  });

  assert.equal(secondPass.imported, 0);
  assert.equal(secondPass.skipped_existing, 1);
  assert.equal(secondPass.conflicts, 0);
  assert.equal(secondPass.errors, 0);
});

test("agent-ops runs importer creates deterministic case seeds from candidate closeout", () => {
  const { agentOpsRoot, catalogRoot, runFilePath } = createCandidateSeedImportFixture();
  const runRef = "memory/runs/2026/04/run_candidate_seed.json";

  const firstPass = importAgentOpsRuns({
    agentOpsRoot,
    catalogRoot,
    workspaceId: "agent_ops_workspace",
    dryRun: false,
  });

  assert.equal(firstPass.imported, 1);
  assert.equal(firstPass.case_seeds_created, 1);
  assert.equal(firstPass.case_seeds_updated, 0);
  assert.equal(firstPass.errors, 0);

  const store = new CaseSeedStore({ rootDir: catalogRoot });
  const seedId = buildCaseSeedId(runRef);
  const seed = store.getSeed(seedId);
  const sourceBytes = fs.readFileSync(runFilePath);

  assert.equal(seed.case_seed_id, seedId);
  assert.equal(seed.run_ref, runRef);
  assert.equal(seed.session_ref, "memory/sessions/2026/04/session_candidate_seed.json");
  assert.equal(seed.thread_ref, "codex-thread://thread-candidate-seed");
  assert.equal(seed.project_id, "agent_ops");
  assert.equal(seed.workspace_id, "agent_ops_workspace");
  assert.equal(seed.seed_packet.problem, "Cron was authoring ECITR semantics outside the acting agent context.");
  assert.equal(seed.seed_packet.confidence, 0.75);
  assert.equal(seed.evidence_links.run_evidence_ref, "ev_aops_run_run_candidate_seed");
  assert.equal(seed.evidence_links.session_evidence_ref, null);
  assert.deepEqual(seed.evidence_links.chat_evidence_refs, []);
  assert.equal(seed.status, "ready_for_review");
  assert.equal(seed.revision, 1);
  assert.equal(seed.source_run_artifact_hash, createSha256(sourceBytes));

  const secondPass = importAgentOpsRuns({
    agentOpsRoot,
    catalogRoot,
    workspaceId: "agent_ops_workspace",
    dryRun: false,
  });

  assert.equal(secondPass.imported, 0);
  assert.equal(secondPass.skipped_existing, 1);
  assert.equal(secondPass.case_seeds_seen_existing, 1);
  assert.equal(store.listSeeds().length, 1);
});

test("agent-ops runs importer creates no case seed for none closeout", () => {
  const { agentOpsRoot, catalogRoot } = createNoneCloseoutImportFixture();

  const result = importAgentOpsRuns({
    agentOpsRoot,
    catalogRoot,
    workspaceId: "agent_ops_workspace",
    dryRun: false,
  });

  assert.equal(result.imported, 1);
  assert.equal(result.case_seeds_created, 0);
  assert.equal(result.case_seeds_skipped_none, 1);

  const store = new CaseSeedStore({ rootDir: catalogRoot });
  assert.deepEqual(store.listSeeds(), []);
});

test("agent-ops runs importer resolves workspace id from the configured project mapping", () => {
  const { agentOpsRoot, catalogRoot } = createProjectMappedImportFixture();

  const summary = importAgentOpsRuns({
    agentOpsRoot,
    catalogRoot,
    projectId: "ms_business_central",
    dryRun: false,
  });

  assert.equal(summary.imported, 1);
  const catalog = new FileBackedCatalog({ rootDir: catalogRoot });
  const record = catalog.getRecord("evidence", buildEvidenceId("run_20260410180000_msbc"));
  assert.equal(record.workspace_id, "ms_business_central");
});

test("agent-ops runs importer treats workspace identity as canonical evidence identity", () => {
  const { agentOpsRoot, catalogRoot } = createImportFixture();

  const first = importAgentOpsRuns({
    agentOpsRoot,
    catalogRoot,
    projectId: "agent_ops",
    workspaceId: "workspace_alpha",
    dryRun: false,
  });
  const identical = importAgentOpsRuns({
    agentOpsRoot,
    catalogRoot,
    projectId: "agent_ops",
    workspaceId: "workspace_alpha",
    dryRun: false,
  });
  const wrongWorkspace = importAgentOpsRuns({
    agentOpsRoot,
    catalogRoot,
    projectId: "agent_ops",
    workspaceId: "workspace_beta",
    dryRun: false,
  });

  assert.equal(first.imported, 1);
  assert.equal(identical.skipped_existing, 1);
  assert.equal(identical.conflicts, 0);
  assert.equal(wrongWorkspace.skipped_existing, 0);
  assert.equal(wrongWorkspace.conflicts, 1);
  assert.deepEqual(wrongWorkspace.conflict_details[0].conflict_fields, ["workspace_id"]);
});

function createImportFixture() {
  const agentOpsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-ops-memory-"));
  const catalogRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-import-catalog-"));
  const runsRoot = path.join(agentOpsRoot, RUNS_RELATIVE_ROOT, "2026", "04");
  const examplesRoot = path.join(agentOpsRoot, RUNS_RELATIVE_ROOT, "_examples");

  fs.mkdirSync(runsRoot, { recursive: true });
  fs.mkdirSync(examplesRoot, { recursive: true });

  const agentOpsRunPath = path.join(runsRoot, "run_20260410173434_mcp.json");
  const otherProjectRunPath = path.join(runsRoot, "run_20260410173435_other.json");
  const exampleRunPath = path.join(examplesRoot, "run_20260410173434_mcp.json");

  writeJson(agentOpsRunPath, {
    id: "run_20260410173434_mcp",
    project_id: "agent_ops",
    agent: "codex_desktop",
    objective: "Test agent-ops import mapping.",
    created_at: "2026-04-10T17:34:34.209Z",
  });
  writeJson(otherProjectRunPath, {
    id: "run_20260410173435_other",
    project_id: "other_project",
    agent: "codex_desktop",
    objective: "Test project filtering.",
    created_at: "2026-04-10T17:34:35.209Z",
  });
  writeJson(exampleRunPath, {
    id: "run_20260410173434_mcp",
    project_id: "agent_ops",
    agent: "codex_desktop",
    objective: "Example runs must not be imported as live evidence.",
    created_at: "2026-04-10T17:34:34.209Z",
  });

  return {
    agentOpsRoot,
    catalogRoot,
    runFilePath: agentOpsRunPath,
  };
}

function createCandidateSeedImportFixture() {
  const agentOpsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-ops-memory-candidate-"));
  const catalogRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-import-candidate-catalog-"));
  const runsRoot = path.join(agentOpsRoot, RUNS_RELATIVE_ROOT, "2026", "04");

  fs.mkdirSync(runsRoot, { recursive: true });

  const runFilePath = path.join(runsRoot, "run_candidate_seed.json");
  writeJson(runFilePath, {
    id: "run_candidate_seed",
    project_id: "agent_ops",
    agent: "codex_desktop",
    objective: "Create closeout seed.",
    steps_completed: ["Moved ECITR learning into closeout."],
    findings: ["The acting agent can answer future decision questions while context is fresh."],
    blockers: [],
    next_actions: ["Import the seed into ECITR staging."],
    session_ref: "memory/sessions/2026/04/session_candidate_seed.json",
    thread_ref: "codex-thread://thread-candidate-seed",
    ecitr_closeout: candidateCloseout(),
    created_at: "2026-04-10T17:34:34.209Z",
  });

  return {
    agentOpsRoot,
    catalogRoot,
    runFilePath,
  };
}

function createNoneCloseoutImportFixture() {
  const agentOpsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-ops-memory-none-"));
  const catalogRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-import-none-catalog-"));
  const runsRoot = path.join(agentOpsRoot, RUNS_RELATIVE_ROOT, "2026", "04");

  fs.mkdirSync(runsRoot, { recursive: true });

  writeJson(path.join(runsRoot, "run_none_seed.json"), {
    id: "run_none_seed",
    project_id: "agent_ops",
    agent: "codex_desktop",
    objective: "No reusable learning.",
    steps_completed: ["Reported status."],
    findings: ["Routine update only."],
    blockers: [],
    next_actions: ["No seed."],
    session_ref: "memory/sessions/2026/04/session_none_seed.json",
    thread_ref: "codex-thread://thread-none-seed",
    ecitr_closeout: {
      decision: "none",
      no_seed_reason_code: "pure_status_update",
      no_seed_reason: "The run only reported status and produced no reusable decision rule.",
    },
    created_at: "2026-04-10T17:34:34.209Z",
  });

  return {
    agentOpsRoot,
    catalogRoot,
  };
}

function candidateCloseout(overrides = {}) {
  return {
    decision: "candidate",
    seed: {
      future_decision: "Decide where ECITR semantic case meaning should be authored.",
      activate_when: "A future agent closes agent-ops work with fresh task context.",
      do_not_apply_when: "The run is routine or has no reusable decision rule.",
      plan_effect: "Create a case seed during run closeout and let importers attach evidence later.",
      problem: "Cron was authoring ECITR semantics outside the acting agent context.",
      constraints: "Semantic fields must come from the run-backed closeout seed.",
      action_taken: "Added an agent-authored closeout seed packet to the run artifact.",
      outcome: "ECITR can stage a draft case from the seed without transcript summarization.",
      failure_mode: "Autonomous transcript distillation can invent or blur reusable meaning.",
      confidence: 0.75,
      ...overrides,
    },
  };
}

function createProjectMappedImportFixture() {
  const agentOpsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-ops-memory-mapped-"));
  const catalogRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-import-catalog-mapped-"));
  const runsRoot = path.join(agentOpsRoot, RUNS_RELATIVE_ROOT, "2026", "04");

  fs.mkdirSync(runsRoot, { recursive: true });
  writeJson(path.join(catalogRoot, "ecitr.project.json"), {
    schema_version: 1,
    workspace_id: "ecitr_model",
    catalog_root: ".",
    default_project_scope: "project",
    preflight_retrieval_mandatory: false,
    failure_retry_retrieval_mandatory: false,
  });
  writeJson(path.join(runsRoot, "run_20260410180000_msbc.json"), {
    id: "run_20260410180000_msbc",
    project_id: "ms_business_central",
    agent: "codex_desktop",
    objective: "Verify workspace mapping.",
    created_at: "2026-04-10T18:00:00.000Z",
  });

  return {
    agentOpsRoot,
    catalogRoot,
  };
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
