const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { FileBackedCatalog } = require("../src/storage/file-backed-catalog");
const { loadExample } = require("./helpers/load-example");
const { parseArgs: parseUsageArgs } = require("../src/cli/record-memory-usage");
const { readTelemetryOption } = require("../src/cli/project-memory-telemetry-options");

const REPO_ROOT = path.resolve(__dirname, "..");
const SESSION_REF = "memory/sessions/2026/09/session_followthrough_fixture.json";
const THREAD_REF = "codex-thread://followthrough-fixture";
const QUERY = "scope filter ranking project retrieval";
const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `${JSON.stringify(value)}\n`); };

function fixture(t, { taskProject = "ecitr_model" } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-followthrough-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, "runtime");
  for (const directory of ["src", "schemas", "config"]) {
    fs.cpSync(path.join(REPO_ROOT, directory), path.join(repo, directory), { recursive: true });
  }
  fs.symlinkSync(fs.realpathSync(path.join(REPO_ROOT, "node_modules")), path.join(repo, "node_modules"));
  const owner = path.join(root, "owner");
  const registry = path.join(owner, "memory/projects/_registry.json");
  const sessionFile = path.join(owner, SESSION_REF);
  write(registry, { schema_version: 1, projects: [{ id: "ecitr_model" }, { id: "general_tasks" }] });
  write(path.join(repo, "config/workspace-source-map.json"), { schema_version: 1, agent_ops_registry_path: registry });
  write(sessionFile, { id: path.basename(SESSION_REF, ".json"), project_id: taskProject, status: "active", thread_ref: THREAD_REF });
  const workspace = path.join(root, "workspace");
  write(path.join(workspace, "ecitr.project.json"), { ...loadExample("ecitr_project"), catalog_root: "catalog", default_project_scope: "project_family" });
  const catalog = new FileBackedCatalog({ rootDir: path.join(workspace, "catalog") });
  const records = Object.fromEntries(["evidence", "case", "invariant", "tactic"].map((type) => [type, loadExample(type)]));
  records.tactic.expiry_at = "2099-01-01T00:00:00Z";
  records.tactic.revalidate_at = "2099-01-01T00:00:00Z";
  for (const [type, record] of Object.entries(records)) catalog.writeRecord(type, record);
  const env = { ...process.env, ECITR_MODEL_ROOT: repo,
    ECITR_LANCEDB_URI: path.join(root, "absent-index"), ECITR_PROJECT_MEMORY_EMBEDDER: "hash" };
  const invoke = (wrapper, args = []) => spawnSync(path.join(REPO_ROOT, "integrations/codex/ecitr-memory/scripts", wrapper), args,
    { cwd: workspace, env, encoding: "utf8" });
  const report = () => success(spawnSync(process.execPath, [path.join(repo, "src/cli/report-memory-invocations.js")],
    { cwd: workspace, env, encoding: "utf8" }));
  return { root, workspace, sessionFile, records, invoke, report };
}

function success(result) {
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function search(f, extra = []) {
  return success(f.invoke("search_project_memory", ["--query", QUERY, "--task-id", "followthrough_task",
    "--session-file", f.sessionFile, "--lane", "diagnostic", ...extra])).memory_invocation;
}

test("wrappers carry exact session context through consultation, preparation and inline output evidence", (t) => {
  const f = fixture(t);
  const sourceBytes = fs.readFileSync(f.sessionFile);
  const invocation = search(f);
  assert.equal(invocation.episode_attribution.status, "verified");
  assert.equal(invocation.episode_attribution.session_ref, SESSION_REF);
  assert.equal(invocation.episode_attribution.thread_ref, THREAD_REF);
  assert.equal(invocation.usage_followthrough.invocation_id, invocation.invocation_id);
  assert.equal(invocation.usage_followthrough.attempt_id, invocation.attempt.attempt_id);
  assert.equal(invocation.usage_followthrough.callback_status, "missing");
  const id = f.records.case.case_id;
  assert.ok(invocation.returned_record_ids.cases.includes(id));
  const prepared = success(f.invoke("read_project_memory_records", ["--invocation-id", invocation.invocation_id, "--record-ids", id]));
  assert.equal(prepared.results[0].result, "available");
  const outputRef = path.join(f.root, "fixture-output.json");
  write(outputRef, { fixture_only: true, used_record_id: id, decision: "Preserve scope before ranking in this controlled example." });
  const usage = success(f.invoke("record_memory_usage", ["--invocation-id", invocation.invocation_id,
    "--used-record-ids", id, "--inspected-record-ids", id,
    "--use-evidence", JSON.stringify({ record_id: id, output_ref: outputRef })]));
  assert.equal(usage.usage_followthrough.callback_status, "recorded");
  assert.deepEqual(usage.usage_followthrough.used_record_ids_without_references, []);
  const stored = read(invocation.artifact_path);
  assert.equal(stored.telemetry.opportunity.binding.session_ref, SESSION_REF);
  assert.equal(stored.telemetry.attempt.context.thread_ref, THREAD_REF);
  assert.equal(stored.use_evidence.links[0].output_ref, outputRef);
  assert.equal(read(stored.use_evidence.links[0].output_ref).used_record_id, id);
  assert.equal(stored.use_evidence.links[0].corroboration.value, null);
  assert.equal(stored.read_receipts.length, 1);
  assert.deepEqual(fs.readFileSync(f.sessionFile), sourceBytes);
  const report = f.report();
  assert.equal(report.joined_task_opportunities, 1);
  assert.equal(report.usage_callbacks, 1);
  assert.equal(report.use_stages.evidence_link_declarations, 1);
  assert.deepEqual(report.usage_followthrough.missing_callback_invocations, []);
  assert.deepEqual(report.usage_followthrough.missing_use_reference_invocations, []);
  assert.equal(report.use_stages.measured_benefit.value, null);
});

test("session-file skip preserves explicit cross-workspace identity and creates no callback", (t) => {
  const f = fixture(t, { taskProject: "general_tasks" });
  const args = ["--task-id", "skip_fixture", "--task-title", "Current source is sufficient", "--session-file", f.sessionFile];
  const undeclared = f.invoke("log_memory_opportunity", args);
  assert.notEqual(undeclared.status, 0);
  assert.equal(JSON.parse(undeclared.stderr).context_error, "cross_workspace_relation_not_declared");
  assert.equal(fs.existsSync(path.join(f.workspace, ".local/memory-invocations")), false);
  const invocation = success(f.invoke("log_memory_opportunity", [...args, "--task-workspace-relation", "cross_workspace"])).memory_invocation;
  assert.equal(invocation.episode_attribution.status, "verified");
  assert.equal(invocation.episode_attribution.task_project_id, "general_tasks");
  assert.equal(invocation.episode_attribution.retrieval_workspace_id, "ecitr_model");
  assert.equal(invocation.episode_attribution.workspace_relation, "cross_workspace");
  assert.equal(invocation.decision, "skip");
  assert.equal(invocation.usage_followthrough.callback_status, "not_applicable");
  assert.equal(read(invocation.artifact_path).usage_recorded_at, null);
  assert.equal(f.report().retrieval_attempts, 0);
});

test("each retry keeps its own callback target and a sibling callback cannot hide the missing attempt", (t) => {
  const f = fixture(t);
  const first = search(f);
  const firstBytes = fs.readFileSync(first.artifact_path);
  const second = search(f, ["--retry-of", first.attempt.attempt_id]);
  assert.equal(second.opportunity_id, first.opportunity_id);
  assert.notEqual(second.invocation_id, first.invocation_id);
  assert.equal(second.usage_followthrough.invocation_id, second.invocation_id);
  success(f.invoke("record_memory_usage", ["--invocation-id", second.invocation_id]));
  const report = f.report();
  assert.equal(report.retrieval_attempts, 2);
  assert.equal(report.usage_callbacks, 1);
  assert.equal(report.explicit_empty_callbacks, 1);
  assert.equal(report.usage_followthrough.missing_callback_invocations.length, 1);
  assert.equal(report.usage_followthrough.missing_callback_invocations[0].invocation_id, first.invocation_id);
  assert.equal(report.usage_followthrough.missing_callback_invocations[0].attempt_id, first.attempt.attempt_id);
  assert.deepEqual(fs.readFileSync(first.artifact_path), firstBytes);
});

test("missing evidence is accepted and surfaced while invalid inline claims cannot alter an invocation", (t) => {
  const f = fixture(t);
  const invocation = search(f);
  const id = f.records.case.case_id;
  const usage = success(f.invoke("record_memory_usage", ["--invocation-id", invocation.invocation_id, "--used-record-ids", id]));
  assert.deepEqual(usage.usage_followthrough.used_record_ids_without_references, [id]);
  const report = f.report();
  assert.equal(report.usage_followthrough.missing_use_reference_invocations[0].invocation_id, invocation.invocation_id);
  assert.deepEqual(report.usage_followthrough.missing_use_reference_invocations[0].used_record_ids_without_references, [id]);
  const bytes = fs.readFileSync(invocation.artifact_path);
  for (const value of ["{malformed", JSON.stringify({ record_id: id, output_ref: "out", corroboration: "verified" }),
    JSON.stringify({ record_id: "case_unreturned", output_ref: "out" }), JSON.stringify({ record_id: id, output_ref: "x".repeat(1025) })]) {
    assert.notEqual(f.invoke("record_memory_usage", ["--invocation-id", invocation.invocation_id, "--used-record-ids", id,
      "--use-evidence", value]).status, 0);
    assert.deepEqual(fs.readFileSync(invocation.artifact_path), bytes);
  }
});

test("conflicting session-file flags fail before writes while legacy literal flags retain visible invalid attribution", (t) => {
  const f = fixture(t);
  for (const extra of [["--session-ref", "session_bare"], ["--thread-ref", "other_thread"]]) {
    const result = f.invoke("log_memory_opportunity", ["--task-id", "conflict", "--task-title", "Conflict fixture",
      "--session-file", f.sessionFile, ...extra]);
    assert.notEqual(result.status, 0);
    assert.equal(JSON.parse(result.stderr).context_error, "session_file_context_conflict");
    assert.equal(fs.existsSync(path.join(f.workspace, ".local/memory-invocations")), false);
  }
  const direct = success(f.invoke("log_memory_opportunity", ["--task-id", "literal", "--task-title", "Literal fixture",
    "--session-ref", "session_bare"])).memory_invocation;
  assert.equal(direct.episode_attribution.status, "invalid");
  assert.equal(direct.episode_attribution.reason, "session_ref_not_canonical");
  assert.equal(direct.episode_attribution.session_ref, "session_bare");
});

test("inline reference lists retain the existing 100-link cap", () => {
  const entry = JSON.stringify({ record_id: "case_fixture", decision_ref: "decision_fixture" });
  const args = ["--invocation-id", "meminv_fixture"];
  for (let index = 0; index < 100; index += 1) args.push("--use-evidence", entry);
  assert.equal(parseUsageArgs(args).useEvidence.length, 100);
  assert.throws(() => parseUsageArgs([...args, "--use-evidence", entry]), { code: "invalid_use_evidence" });
});

test("repeated contradictory telemetry flags cannot erase an earlier identity or audit boundary", (t) => {
  for (const [flag, first, second] of [
    ["--session-file", "/owner/memory/sessions/2026/09/session_a.json", "/owner/memory/sessions/2026/09/session_b.json"],
    ["--session-ref", SESSION_REF, "memory/sessions/2026/09/session_other.json"],
    ["--thread-ref", THREAD_REF, "codex-thread://other"],
    ["--run-ref", "memory/runs/2026/09/run_a.json", "memory/runs/2026/09/run_b.json"],
    ["--episode-id", "episode_a", "episode_b"],
    ["--task-workspace-relation", "same_workspace", "cross_workspace"],
    ["--lane", "diagnostic", "micro"],
    ["--audit-mode", "controlled_read_only", "strict_no_write"],
    ["--retry-of", "attempt_a", "attempt_b"],
  ]) {
    for (const [left, right] of [[first, second], [second, first]]) {
      const options = {};
      assert.equal(readTelemetryOption(options, flag, left), true);
      assert.equal(readTelemetryOption(options, flag, left), true);
      assert.throws(() => readTelemetryOption(options, flag, right), { telemetry_context_error: "telemetry_option_conflict" });
    }
  }
  const f = fixture(t);
  for (const values of [[SESSION_REF, "memory/sessions/2026/09/session_other.json", SESSION_REF],
    ["memory/sessions/2026/09/session_other.json", SESSION_REF]]) {
    const result = f.invoke("log_memory_opportunity", ["--task-id", "repeated", "--task-title", "Repeated identity fixture",
      "--session-file", f.sessionFile, ...values.flatMap((value) => ["--session-ref", value])]);
    assert.notEqual(result.status, 0);
    assert.equal(JSON.parse(result.stderr).context_error, "telemetry_option_conflict");
    assert.equal(fs.existsSync(path.join(f.workspace, ".local/memory-invocations")), false);
  }
});
