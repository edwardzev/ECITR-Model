const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { FileBackedCatalog } = require("../src/storage/file-backed-catalog");
const {
  assertDisjointMigrationTargets,
  migrateRegisteredWorkspaceAttribution,
} = require("../src/workspace/registered-attribution-migration");
const { parseArgs } = require("../src/cli/migrate-workspace-attribution");

test("registered attribution migration plans every configured active workspace", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-registered-migration-"));
  const catalog = new FileBackedCatalog({ rootDir });
  const payloadDir = path.join(rootDir, "payloads");
  fs.mkdirSync(payloadDir, { recursive: true });
  writeJson(path.join(payloadDir, "alpha.json"), { project_id: "alpha_alias" });
  catalog.writeRecord("evidence", makeEvidence("ev_alpha", "payloads/alpha.json"));

  const summary = migrateRegisteredWorkspaceAttribution({
    catalogRoot: rootDir,
    dryRun: true,
    includeStaging: false,
    plannedAt: "2099-01-01T00:00:00.000Z",
    sourceMap: {
      agent_ops_projects: [],
      codex_workspaces: [],
      agent_ops_registry_projects: [
        {
          id: "alpha",
          aliases: ["alpha_alias"],
          workspace_roots: [path.join(rootDir, "alpha")],
        },
        {
          id: "beta",
          aliases: [],
          workspace_roots: [path.join(rootDir, "beta")],
        },
      ],
    },
  });

  assert.equal(summary.workspace_count, 2);
  assert.equal(summary.totals.evidence, 1);
  assert.equal(summary.workspaces.find((entry) => entry.target_workspace_id === "alpha")
    .updated_record_counts.evidence, 1);
  assert.equal(catalog.getRecord("evidence", "ev_alpha_workspace_alpha"), null);
});

test("registered attribution migration assigns nested roots to the longest matching workspace", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-nested-migration-"));
  const catalog = new FileBackedCatalog({ rootDir });
  const parentRoot = path.join(rootDir, "projects");
  const childRoot = path.join(parentRoot, "child");
  const payloadDir = path.join(rootDir, "payloads");
  fs.mkdirSync(payloadDir, { recursive: true });
  writeJson(path.join(payloadDir, "child.json"), { cwd: path.join(childRoot, "src") });
  catalog.writeRecord("evidence", {
    ...makeEvidence("ev_child", "payloads/child.json"),
    source_type: "chat",
  });

  const summary = migrateRegisteredWorkspaceAttribution({
    catalogRoot: rootDir,
    dryRun: true,
    includeStaging: false,
    plannedAt: "2099-01-01T00:00:00.000Z",
    sourceMap: {
      agent_ops_projects: [],
      codex_workspaces: [],
      agent_ops_registry_projects: [
        { id: "parent", aliases: [], workspace_roots: [parentRoot] },
        { id: "child", aliases: [], workspace_roots: [childRoot] },
      ],
    },
  });

  assert.equal(summary.totals.evidence, 1);
  assert.equal(summary.workspaces.find((entry) => entry.target_workspace_id === "parent")
    .updated_record_counts.evidence, 0);
  assert.equal(summary.workspaces.find((entry) => entry.target_workspace_id === "child")
    .updated_record_counts.evidence, 1);
});

test("workspace attribution CLI is dry-run by default and requires --apply for writes", () => {
  assert.equal(parseArgs([]).dryRun, true);
  assert.equal(parseArgs(["--apply"]).dryRun, false);
  assert.equal(parseArgs(["--apply", "--dry-run"]).dryRun, true);
});

test("registry-wide migration rejects one target record claimed by two workspaces", () => {
  const operation = {
    record_type: "case",
    target_record_id: "case_shared",
  };
  assert.throws(() => assertDisjointMigrationTargets([
    {
      manifest: {
        target_workspace_id: "alpha",
        operations: [operation],
      },
    },
    {
      manifest: {
        target_workspace_id: "beta",
        operations: [operation],
      },
    },
  ]), /claimed by both alpha and beta/);
});

function makeEvidence(evidenceId, payloadRef) {
  return {
    evidence_id: evidenceId,
    workspace_id: "ecitr_model",
    substrate_ref: `file:///tmp/${evidenceId}.json`,
    source_type: "file",
    source_locator: `/tmp/${evidenceId}.json`,
    captured_at: "2099-01-01T00:00:00.000Z",
    project_scope: "project",
    actor_scope: "mixed",
    verbatim_payload_ref: payloadRef,
    payload_hash: "sha256:test",
    source_hash: "sha256:test",
    redaction_state: "none",
    immutable: true,
  };
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
