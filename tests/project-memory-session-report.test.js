const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { summarizeSessionMemoryInvocations } = require("../src/runtime/project-memory-session-report");
const { loadMemoryInvocationArtifactsStrict } = require("../src/runtime/project-memory");
const { buildOpportunity, startAttempt, validateTelemetry, buildUseEvidence } = require("../src/runtime/project-memory-telemetry");
const { loadEcitrProjectConfig } = require("../src/workspace/config");
const { parseArgs } = require("../src/cli/report-memory-invocations");

const REPO = path.resolve(__dirname, "..");
const SESSION = "memory/sessions/2026/09/session_followthrough_target.json";
const OTHER = "memory/sessions/2026/09/session_followthrough_other.json";
const RUN = "memory/runs/2026/09/run_followthrough_target.json";
const THREAD = "codex-thread://11111111-2222-4333-8444-555555555555";
const NOW = new Date("2026-09-27T10:00:00.000Z");
const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const write = (file, data) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(data) + "\n"); };

function fixture(t, { taskProject = "project_a" } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-session-report-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const owner = path.join(root, "owner");
  const registry = path.join(owner, "memory/projects/_registry.json");
  const sourceMapPath = path.join(root, "source-map.json");
  write(registry, { schema_version: 1, projects: [{ id: "project_a" }, { id: "project_b" }] });
  write(sourceMapPath, { schema_version: 1, agent_ops_registry_path: registry });
  for (const ref of [SESSION, OTHER]) write(path.join(owner, ref), {
    id: path.basename(ref, ".json"), project_id: taskProject, status: "active", thread_ref: THREAD,
  });
  const workspace = path.join(root, "workspace");
  write(path.join(workspace, "ecitr.project.json"), { schema_version: 1, workspace_id: "project_a",
    catalog_root: "catalog-does-not-exist", default_project_scope: "project",
    preflight_retrieval_mandatory: false, failure_retry_retrieval_mandatory: false });
  const config = loadEcitrProjectConfig({ startDir: workspace });
  const artifactRoot = path.join(workspace, ".local/memory-invocations");
  fs.mkdirSync(artifactRoot, { recursive: true });
  const sessionFile = path.join(owner, SESSION);
  const relation = taskProject === "project_a" ? {} : { task_workspace_relation: "cross_workspace" };
  const report = (options = {}) => summarizeSessionMemoryInvocations({ artifactRoot, projectConfig: config,
    sessionFile, context: relation, sourceMapPath, now: NOW, ...options });
  function artifact(id, { sessionRef = SESSION, decision = "consult", callback = false, status = "succeeded", retryOf = null } = {}) {
    const session = read(path.join(owner, sessionRef));
    const context = { session_ref: sessionRef, thread_ref: session.thread_ref ?? null, lane: "governed-write", ...relation,
      ...(retryOf ? { retry_of: retryOf } : {}) };
    const telemetry = buildOpportunity({ projectConfig: config, context, taskPacket: { task_id: "fixture_task" }, now: NOW, sourceMapPath });
    Object.assign(telemetry.opportunity, { decision, decision_reason: "controlled_fixture", decision_at: NOW.toISOString() });
    if (decision === "consult") {
      telemetry.attempt = startAttempt({ invocationId: id, trigger: "discretionary", context, now: NOW });
      if (status !== "running") Object.assign(telemetry.attempt, { status, finished_at: "2026-09-27T10:00:01.000Z",
        duration_ms: 1000, duration_reason: null, error_code: status === "failed" ? "retrieval_failed" : status === "cancelled" ? "retrieval_cancelled" : null });
    }
    validateTelemetry(telemetry);
    const data = { invocation_id: id, workspace_id: config.workspace_id, catalog_root: config.catalog_root,
      marker_path: config.marker_path, default_project_scope: config.default_project_scope,
      consulted_at: NOW.toISOString(), task_id: "fixture_task", consult_trigger: "discretionary",
      memory_consulted: decision === "consult", returned_counts: { tactics: 0, invariants: 0, cases: 0, evidence: 0 },
      returned_record_ids: { tactics: [], invariants: [], cases: [], evidence: [] }, telemetry,
      usage_recorded_at: callback ? "2026-09-27T10:00:02.000Z" : null, used_memory: false,
      used_record_ids: [], used_returned_record_ids: [], selected_record_ids: [] };
    const file = path.join(artifactRoot, "2026/09", id + ".json");
    write(file, data);
    return { file, data };
  }
  function close(overrides = {}) {
    write(path.join(owner, RUN), { id: path.basename(RUN, ".json"), project_id: taskProject,
      session_ref: SESSION, thread_ref: read(sessionFile).thread_ref, execution_outcome: "completed", ...overrides });
    write(sessionFile, { ...read(sessionFile), status: "closed", run_ref: RUN });
  }
  return { root, owner, registry, workspace, artifactRoot, sessionFile, sourceMapPath, config, report, artifact, close };
}

test("exact session isolation preserves each search callback even when another session shares the thread", (t) => {
  const f = fixture(t);
  const first = f.artifact("meminv_first");
  f.artifact("meminv_second", { callback: true, retryOf: first.data.telemetry.attempt.attempt_id });
  f.artifact("meminv_other_session", { sessionRef: OTHER, callback: true });
  const before = fs.readFileSync(first.file);
  const result = f.report();
  assert.equal(result.recorded_invocations, 2);
  assert.equal(result.consultations, 2);
  assert.equal(result.usage_callbacks, 1);
  assert.equal(result.explicit_empty_callbacks, 1);
  assert.deepEqual(result.missing_callback_invocations.map((x) => x.invocation_id), ["meminv_first"]);
  assert.equal(result.missing_callback_invocations[0].attempt_id, first.data.telemetry.attempt.attempt_id);
  assert.equal(result.native_task_identity.status, "canonical_reference");
  assert.equal(result.run_linkage.status, "not_recorded_before_closeout");
  assert.deepEqual(result.coverage.evidence_issues, []);
  assert.deepEqual(fs.readFileSync(first.file), before);
  assert.equal(fs.existsSync(f.config.catalog_root), false);
});

test("unobserved, unavailable directory and explicit skip stay distinct", (t) => {
  const f = fixture(t);
  assert.equal(f.report().retrieval_decision.status, "unobserved");
  fs.rmdirSync(f.artifactRoot);
  let result = f.report();
  assert.equal(result.coverage.enumeration_complete, false);
  assert.equal(result.retrieval_decision.status, "unobserved");
  f.artifact("meminv_skip", { decision: "skip" });
  result = f.report();
  assert.equal(result.retrieval_decision.status, "observed");
  assert.equal(result.retrieval_decision.by_decision.skip, 1);
  assert.equal(result.usage_callbacks, 0);
  assert.deepEqual(result.missing_callback_invocations, []);
});

test("failed, cancelled and still-running attempts retain individual missing callback targets", (t) => {
  const f = fixture(t);
  for (const status of ["failed", "cancelled", "running"]) f.artifact("meminv_" + status, { status });
  const result = f.report();
  assert.equal(result.missing_callback_invocations.length, 3);
  assert.deepEqual(result.running_attempts.map((x) => x.invocation_id), ["meminv_running"]);
});

test("missing and legacy native identity remain separate from exact episode attribution", (t) => {
  const f = fixture(t);
  for (const thread of [null, "codex-thread://legacy_literal"] ) {
    write(f.sessionFile, { ...read(f.sessionFile), thread_ref: thread });
    const result = f.report();
    assert.equal(result.episode_attribution.status, "verified");
    assert.equal(result.native_task_identity.status, "unavailable");
    assert.equal(result.session.thread_ref, thread);
  }
});

test("post-closeout follows only the explicit reciprocal run and preserves invocation bytes", (t) => {
  const f = fixture(t);
  const skip = f.artifact("meminv_skip", { decision: "skip" });
  const before = fs.readFileSync(skip.file);
  f.close();
  const result = f.report();
  assert.equal(result.run_linkage.status, "reciprocal");
  assert.equal(result.run_linkage.run.ref, RUN);
  assert.equal(result.run_linkage.execution_outcome, "completed");
  assert.equal(result.run_linkage.run.session_ref, SESSION);
  assert.deepEqual(result.coverage.evidence_issues, []);
  assert.equal(read(skip.file).telemetry.opportunity.binding.run_ref, null);
  assert.deepEqual(fs.readFileSync(skip.file), before);
  for (const overrides of [{ project_id: "project_b" }, { session_ref: OTHER }, { thread_ref: undefined }]) {
    f.close(overrides);
    assert.throws(() => f.report(), /run_identity_conflict|run_thread_ref_conflict/);
  }
});

test("closed session without a run and contradictory explicit task context remain gaps", (t) => {
  const f = fixture(t);
  write(f.sessionFile, { ...read(f.sessionFile), status: "closed" });
  assert.ok(f.report().coverage.evidence_issues.some((x) => x.reason === "closed_session_run_ref_missing"));
  assert.throws(() => f.report({ context: { thread_ref: "different" } }), { code: "session_file_context_conflict" });
  assert.throws(() => f.report({ sessionFile: null, context: { session_ref: "session_bare" } }), { code: "session_ref_not_canonical" });
});

test("conflicting duplicate deliveries cannot escape quarantine by rebinding one to another session", (t) => {
  const f = fixture(t);
  const first = f.artifact("meminv_shared");
  const bytes = fs.readFileSync(first.file);
  const other = f.artifact("meminv_shared", { sessionRef: OTHER, callback: true });
  write(path.join(f.artifactRoot, "duplicate.json"), other.data);
  fs.writeFileSync(first.file, bytes);
  const result = f.report();
  assert.equal(result.recorded_invocations, 0);
  assert.equal(result.conflicting_deliveries.length, 1);
  assert.ok(result.coverage.evidence_issues.some((x) => x.reason === "conflicting_invocation_evidence"));
});

test("unreadable metadata, unsupported telemetry and unsafe sources cannot imply complete coverage", (t) => {
  const f = fixture(t);
  const good = f.artifact("meminv_good", { callback: true });
  fs.writeFileSync(path.join(f.artifactRoot, "broken.json"), "{broken");
  write(path.join(f.artifactRoot, "shape.json"), { memory_consulted: true });
  const unsupported = f.artifact("meminv_unsupported");
  unsupported.data.telemetry.schema_version = 99; write(unsupported.file, unsupported.data);
  fs.symlinkSync(good.file, path.join(f.artifactRoot, "alias.json"));
  const result = f.report();
  assert.equal(result.coverage.enumeration_complete, false);
  assert.ok(result.coverage.evidence_issues.some((x) => x.reason === "unsupported_telemetry_schema"));
  assert.ok(result.coverage.evidence_issues.some((x) => x.reason === "invalid_invocation_shape"));
  assert.ok(result.coverage.evidence_issues.some((x) => x.reason === "invocation_symlink_not_followed"));
  assert.equal(result.usage_callbacks, 1);
});

test("malformed callback timestamp and attempt binding cannot become successful follow-through", (t) => {
  const f = fixture(t);
  const badCallback = f.artifact("meminv_bad_callback", { callback: true });
  badCallback.data.usage_recorded_at = "not-a-time"; write(badCallback.file, badCallback.data);
  const badAttempt = f.artifact("meminv_bad_attempt");
  badAttempt.data.telemetry.attempt.context.session_ref = OTHER; write(badAttempt.file, badAttempt.data);
  const result = f.report();
  assert.equal(result.recorded_invocations, 0);
  assert.ok(result.coverage.evidence_issues.some((x) => x.reason === "invalid_usage_callback_shape"));
  assert.ok(result.coverage.evidence_issues.some((x) => x.reason === "attempt_binding_conflict"));
});

test("explicit cross-workspace scope preserves both owners", (t) => {
  const f = fixture(t, { taskProject: "project_b" });
  f.artifact("meminv_cross", { callback: true });
  const result = f.report();
  assert.equal(result.episode_attribution.task_project_id, "project_b");
  assert.equal(result.episode_attribution.retrieval_workspace_id, "project_a");
  assert.equal(result.usage_callbacks, 1);
  assert.deepEqual(result.coverage.evidence_issues, []);
  assert.throws(() => f.report({ context: {} }), { code: "cross_workspace_relation_not_declared" });
});

test("matching artifact and binding claims cannot override the configured retrieval workspace", (t) => {
  const f = fixture(t);
  for (const [index, change] of [
    (data) => { data.catalog_root = data.telemetry.opportunity.binding.catalog_root = "/unrelated/catalog"; },
    (data) => { data.telemetry.opportunity.binding.workspace_root = "/unrelated/workspace"; },
    (data) => { data.marker_path = "/unrelated/ecitr.project.json"; },
    (data) => { data.default_project_scope = "global"; },
    (data) => { data.task_id = "another_task"; },
  ].entries()) {
    const row = f.artifact("meminv_scope_" + index, { callback: true });
    change(row.data); write(row.file, row.data);
  }
  const result = f.report();
  assert.equal(result.recorded_invocations, 0);
  assert.equal(result.usage_callbacks, 0);
  assert.equal(result.coverage.evidence_issues.filter((issue) => issue.reason === "invocation_binding_conflict").length, 5);
});

test("callback declarations obey the writer's reference and returned-ID contracts", (t) => {
  const f = fixture(t);
  const used = () => {
    const row = f.artifact("meminv_usage", { callback: true });
    row.data.returned_record_ids.cases = ["case_returned"];
    row.data.returned_counts.cases = 1;
    row.data.used_record_ids = ["case_nonreturned", "case_returned"];
    row.data.used_returned_record_ids = ["case_returned"];
    row.data.used_memory = true;
    row.data.use_evidence = buildUseEvidence({ inspectedRecordIds: ["case_returned"],
      useEvidence: [{ record_id: "case_returned", output_ref: "local:verified-output" }] });
    return row;
  };
  let row = used(); write(row.file, row.data);
  assert.equal(f.report().usage_callbacks, 1);
  assert.deepEqual(f.report().coverage.evidence_issues, []);
  for (const change of [
    (data) => { data.use_evidence.links[0].output_ref = true; },
    (data) => { data.use_evidence.links[0].output_ref = "x".repeat(1025); },
    (data) => { data.use_evidence.links[0].record_id = "case_nonreturned"; },
    (data) => { data.used_returned_record_ids = ["case_nonreturned"]; data.use_evidence.links[0].record_id = "case_nonreturned"; },
    (data) => { data.used_memory = false; },
    (data) => { data.used_record_ids = []; },
    (data) => { data.use_evidence.links[0].corroboration = { value: true, reason: null }; },
  ]) {
    row = used(); change(row.data); write(row.file, row.data);
    const result = f.report();
    assert.equal(result.usage_callbacks, 0);
    assert.ok(result.coverage.evidence_issues.some((issue) => ["invalid_usage_callback_shape", "invalid_use_evidence"].includes(issue.reason)));
  }
  row = used();
  row.data.used_record_ids = ["case_nonreturned"];
  row.data.used_returned_record_ids = [];
  row.data.used_memory = false;
  delete row.data.use_evidence; write(row.file, row.data);
  const legacy = f.report();
  assert.equal(legacy.usage_callbacks, 1);
  assert.equal(legacy.reported_no_influence_callbacks, 1);
  assert.equal(legacy.explicit_empty_callbacks, 0);
  assert.deepEqual(legacy.coverage.evidence_issues, []);
});

test("attempt runs and episode declarations are checked while a later reciprocal run remains valid", (t) => {
  const f = fixture(t);
  const row = f.artifact("meminv_context", { callback: true });
  row.data.telemetry.attempt.context.run_ref = "memory/runs/2026/09/run_nonexistent.json";
  write(row.file, row.data);
  assert.equal(f.report().recorded_invocations, 0);
  assert.ok(f.report().coverage.evidence_issues.some((issue) => issue.reason === "run_unavailable"));
  row.data.telemetry.attempt.context.run_ref = null;
  row.data.telemetry.attempt.context.episode_id = "different_episode"; write(row.file, row.data);
  assert.ok(f.report().coverage.evidence_issues.some((issue) => issue.reason === "attempt_binding_conflict"));
  row.data.telemetry.attempt.context.episode_id = null;
  f.close();
  row.data.telemetry.attempt.context.run_ref = RUN; write(row.file, row.data);
  const before = fs.readFileSync(row.file);
  assert.equal(f.report().usage_callbacks, 1);
  assert.deepEqual(f.report().coverage.evidence_issues, []);
  assert.equal(read(row.file).telemetry.opportunity.binding.run_ref, null);
  assert.deepEqual(fs.readFileSync(row.file), before);
  row.data.telemetry.schema_version = 1;
  delete row.data.telemetry.opportunity.attribution;
  delete row.data.telemetry.opportunity.binding.task_workspace_relation;
  row.data.telemetry.opportunity.binding.run_ref = "memory/runs/2026/09/run_nonexistent.json";
  write(row.file, row.data);
  assert.ok(f.report().coverage.evidence_issues.some((issue) => issue.reason === "run_unavailable"));
});

test("source changes during reporting remain explicit and do not rewrite the old observation", (t) => {
  const f = fixture(t);
  const target = f.artifact("meminv_changing");
  const result = f.report({ loader: (options) => {
    const snapshot = loadMemoryInvocationArtifactsStrict(options);
    write(target.file, { ...target.data, usage_recorded_at: "2026-09-27T10:00:02.000Z" });
    f.close();
    return snapshot;
  } });
  assert.equal(result.usage_callbacks, 0);
  assert.equal(result.coverage.enumeration_complete, false);
  assert.ok(result.coverage.evidence_issues.some((x) => x.reason === "invocation_source_changed_during_report"));
  assert.ok(result.coverage.evidence_issues.some((x) => x.reason === "episode_source_changed_during_report"));
});

test("report budget stops with visible incomplete enumeration", (t) => {
  const f = fixture(t);
  f.artifact("meminv_one"); f.artifact("meminv_two");
  const result = f.report({ loader: (options) => loadMemoryInvocationArtifactsStrict({ ...options, maxFiles: 1 }) });
  assert.equal(result.coverage.enumeration_complete, false);
  assert.ok(result.coverage.evidence_issues.some((x) => x.reason === "invocation_report_budget_exceeded"));
});

test("CLI and installed-style wrapper verify open and closed sessions without a catalog", (t) => {
  const f = fixture(t);
  f.artifact("meminv_skip", { decision: "skip" });
  const runtime = path.join(f.root, "runtime");
  for (const directory of ["src", "schemas", "config"]) fs.cpSync(path.join(REPO, directory), path.join(runtime, directory), { recursive: true });
  fs.symlinkSync(fs.realpathSync(path.join(REPO, "node_modules")), path.join(runtime, "node_modules"));
  write(path.join(runtime, "config/workspace-source-map.json"), { schema_version: 1, agent_ops_registry_path: f.registry });
  const env = { ...process.env, ECITR_MODEL_ROOT: runtime };
  const command = path.join(REPO, "integrations/codex/ecitr-memory/scripts/report_memory_invocations");
  const invoke = (args) => spawnSync(command, args, { cwd: f.workspace, env, encoding: "utf8" });
  let result = invoke(["--session-file", f.sessionFile]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).run_linkage.status, "not_recorded_before_closeout");
  f.close();
  result = invoke(["--session-ref", SESSION, "--thread-ref", THREAD]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).run_linkage.status, "reciprocal");
  for (const args of [["--workspace-id", "project_b"], ["--catalog-root", "/unrelated/catalog"]]) {
    result = invoke(["--session-file", f.sessionFile, "--workspace-root", f.workspace, ...args]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /selector conflicts/);
  }
  result = invoke([]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).report_schema_version, 3);
  assert.equal(fs.existsSync(f.config.catalog_root), false);
});

test("exact-session CLI rejects conflicting context and filters that could hide callbacks", () => {
  assert.throws(() => parseArgs(["--session-ref", SESSION, "--since", NOW.toISOString()]), /cannot use a time/);
  assert.throws(() => parseArgs(["--session-ref", SESSION, "--population-file", "/tmp/p.json"]), /cannot use a time/);
  assert.throws(() => parseArgs(["--thread-ref", THREAD]), /requires an explicit session/);
  assert.throws(() => parseArgs(["--session-ref", SESSION, "--session-ref", OTHER]), /Conflicting telemetry/);
  assert.throws(() => parseArgs(["--session-file"]), /requires a value/);
  assert.throws(() => parseArgs(["--session-ref", SESSION, "--workspace-id", "a", "--workspace-id", "b"]), /Conflicting exact-session/);
});
