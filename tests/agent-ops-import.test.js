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

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
