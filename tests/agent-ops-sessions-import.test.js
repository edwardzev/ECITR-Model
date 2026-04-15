const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { importAgentOpsRuns, RUNS_RELATIVE_ROOT } = require("../src/importers/agent-ops-runs");
const {
  importAgentOpsSessions,
  buildSessionEvidenceId,
  SESSIONS_RELATIVE_ROOT,
} = require("../src/importers/agent-ops-sessions");
const { FileBackedCatalog } = require("../src/storage/file-backed-catalog");
const { createSha256 } = require("../src/evidence/file-payload-store");

test("agent-ops sessions importer maps terminal sessions and skips active sessions", () => {
  const { agentOpsRoot, catalogRoot } = createImportFixture();
  seedRunsIntoCatalog({ agentOpsRoot, catalogRoot });

  const result = importAgentOpsSessions({
    agentOpsRoot,
    catalogRoot,
    dryRun: true,
  });

  assert.equal(result.scanned_files, 3);
  assert.equal(result.candidate_sessions, 3);
  assert.equal(result.eligible_sessions, 2);
  assert.equal(result.planned, 2);
  assert.equal(result.skipped_non_terminal, 1);
  assert.equal(result.errors, 0);
  assert.ok(
    result.sample_results.some(
      (entry) => entry.evidence_id === buildSessionEvidenceId("session_20260410172725640_nrq7b6"),
    ),
  );
});

test("agent-ops sessions importer writes supporting evidence with parent links", () => {
  const { agentOpsRoot, catalogRoot, sessionFilePath } = createImportFixture();
  seedRunsIntoCatalog({ agentOpsRoot, catalogRoot });

  const firstPass = importAgentOpsSessions({
    agentOpsRoot,
    catalogRoot,
    dryRun: false,
  });

  assert.equal(firstPass.imported, 2);
  assert.equal(firstPass.skipped_existing, 0);
  assert.equal(firstPass.skipped_non_terminal, 1);
  assert.equal(firstPass.errors, 0);

  const catalog = new FileBackedCatalog({ rootDir: catalogRoot });
  const evidenceId = buildSessionEvidenceId("session_20260410172725640_nrq7b6");
  const record = catalog.getRecord("evidence", evidenceId);
  const sourceBytes = fs.readFileSync(sessionFilePath);
  const payloadPath = path.join(catalogRoot, ...record.verbatim_payload_ref.split("/"));

  assert.equal(record.parent_evidence_id, "ev_aops_run_run_20260410173434_mcp");
  assert.equal(record.captured_at, "2026-04-10T17:34:34.211Z");
  assert.equal(record.source_hash, createSha256(sourceBytes));
  assert.equal(fs.readFileSync(payloadPath, "utf8"), sourceBytes.toString("utf8"));

  const secondPass = importAgentOpsSessions({
    agentOpsRoot,
    catalogRoot,
    dryRun: false,
  });

  assert.equal(secondPass.imported, 0);
  assert.equal(secondPass.skipped_existing, 2);
  assert.equal(secondPass.skipped_non_terminal, 1);
  assert.equal(secondPass.errors, 0);
});

function seedRunsIntoCatalog({ agentOpsRoot, catalogRoot }) {
  const result = importAgentOpsRuns({
    agentOpsRoot,
    catalogRoot,
    dryRun: false,
  });

  assert.equal(result.imported, 1);
  assert.equal(result.errors, 0);
}

function createImportFixture() {
  const agentOpsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-ops-session-memory-"));
  const catalogRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-session-catalog-"));
  const runsRoot = path.join(agentOpsRoot, RUNS_RELATIVE_ROOT, "2026", "04");
  const sessionsRoot = path.join(agentOpsRoot, SESSIONS_RELATIVE_ROOT, "2026", "04");

  fs.mkdirSync(runsRoot, { recursive: true });
  fs.mkdirSync(sessionsRoot, { recursive: true });

  const runFilePath = path.join(runsRoot, "run_20260410173434_mcp.json");
  const sessionFilePath = path.join(sessionsRoot, "session_20260410172725640_nrq7b6.json");
  const abandonedSessionPath = path.join(sessionsRoot, "session_20260403181313556_3egyzr.json");
  const activeSessionPath = path.join(sessionsRoot, "session_20260408081507644_anerwq.json");
  const contextBundlePath = path.join(sessionsRoot, "context_session_20260410172725640_nrq7b6.json");

  writeJson(runFilePath, {
    id: "run_20260410173434_mcp",
    project_id: "agent_ops",
    agent: "codex_desktop",
    objective: "Test agent-ops run import mapping.",
    created_at: "2026-04-10T17:34:34.209Z",
  });
  writeJson(sessionFilePath, {
    id: "session_20260410172725640_nrq7b6",
    project_id: "agent_ops",
    project_registry_ref: "memory/projects/_registry.json#agent_ops",
    resolution_mode: "cwd",
    requested_cwd: "/Users/edwardzev/agent-ops",
    resolved_workspace_root: "/Users/edwardzev/agent-ops",
    query: "Harden the ECITR local Qdrant operation path.",
    status: "closed",
    started_by: "codex_desktop",
    context_bundle_ref: "memory/sessions/2026/04/context_session_20260410172725640_nrq7b6.json",
    started_at: "2026-04-10T17:27:25.640Z",
    run_ref: "memory/runs/2026/04/run_20260410173434_mcp.json",
    closed_at: "2026-04-10T17:34:34.211Z",
    closed_by: "codex",
    closure_notes: "Completed the qdrant hardening flow.",
  });
  writeJson(abandonedSessionPath, {
    id: "session_20260403181313556_3egyzr",
    project_id: "agent_ops",
    project_registry_ref: "memory/projects/_registry.json#agent_ops",
    resolution_mode: "cwd",
    requested_cwd: "/Users/edwardzev/agent-ops",
    resolved_workspace_root: "/Users/edwardzev/agent-ops",
    query: "phase2 smoke",
    status: "abandoned",
    context_bundle_ref: "memory/sessions/2026/04/context_session_20260403181313556_3egyzr.json",
    started_at: "2026-04-03T18:13:13.556Z",
    closed_at: "2026-04-03T18:16:56.022Z",
    closure_notes: "Temporary CLI smoke session.",
  });
  writeJson(activeSessionPath, {
    id: "session_20260408081507644_anerwq",
    project_id: "pm_clients_portal",
    project_registry_ref: "memory/projects/_registry.json#pm_clients_portal",
    resolution_mode: "cwd",
    requested_cwd: "/Users/edwardzev/PM Client's Portal",
    resolved_workspace_root: "/Users/edwardzev/PM Client's Portal",
    query: "Fix the orders page Method field.",
    status: "active",
    started_by: "codex_desktop",
    context_bundle_ref: "memory/sessions/2026/04/context_session_20260408081507644_anerwq.json",
    started_at: "2026-04-08T08:15:07.644Z",
  });
  writeJson(contextBundlePath, {
    query: "Context bundles are out of scope for this tranche.",
  });

  return {
    agentOpsRoot,
    catalogRoot,
    sessionFilePath,
  };
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
