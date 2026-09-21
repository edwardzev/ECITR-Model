const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { inspectEpisodeAttribution, contextFromSessionFile, SOURCE_LIMIT_BYTES } = require("../src/runtime/project-memory-context");
const { buildOpportunity, validateTelemetry } = require("../src/runtime/project-memory-telemetry");
const { ProjectMemorySurface, loadMemoryInvocationArtifacts } = require("../src/runtime/project-memory");
const { summarizeTelemetryArtifacts } = require("../src/runtime/project-memory-telemetry-report");
const { loadEcitrProjectConfig } = require("../src/workspace/config");
const { readTelemetryOption } = require("../src/cli/project-memory-telemetry-options");

const SESSION = "memory/sessions/2026/09/session_20260913010101000_fixture.json";
const RUN = "memory/runs/2026/09/run_20260913010201000_fixture.json";
const THREAD = "codex-thread://literal_fixture";
const TASK = { task_id: "source_attribution_fixture", title: "Source identity fixture" };
const NOW = new Date("2026-09-13T01:01:00Z");
const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const write = (file, data) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `${JSON.stringify(data)}\n`); };

function fixture(t, { workspaceId = "task_project" } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-context-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ownerRoot = path.join(root, "owner");
  const sourceMapPath = path.join(root, "config", "workspace-source-map.json");
  const registryPath = path.join(ownerRoot, "memory", "projects", "_registry.json");
  const sessionPath = path.join(ownerRoot, SESSION);
  const runPath = path.join(ownerRoot, RUN);
  write(sourceMapPath, { schema_version: 1, agent_ops_registry_path: registryPath });
  write(registryPath, { schema_version: 1, projects: [{ id: "task_project", status: "active" }, { id: "other_project", status: "active" }] });
  write(sessionPath, { id: path.basename(SESSION, ".json"), project_id: "task_project", status: "active", thread_ref: THREAD });
  const workspace = path.join(root, "workspace");
  write(path.join(workspace, "ecitr.project.json"), { schema_version: 1, workspace_id: workspaceId,
    catalog_root: "./catalog", default_project_scope: "project", preflight_retrieval_mandatory: false,
    failure_retry_retrieval_mandatory: false });
  const config = loadEcitrProjectConfig({ startDir: workspace });
  const context = { episode_id: "literal_episode", session_ref: SESSION, thread_ref: THREAD, lane: "diagnostic" };
  const surface = new ProjectMemorySurface({ projectConfig: config, telemetrySourceMapPath: sourceMapPath });
  const inspect = (overrides = {}) => inspectEpisodeAttribution({ projectConfig: config, context: { ...context, ...overrides }, now: NOW, sourceMapPath });
  return { root, ownerRoot, sourceMapPath, registryPath, sessionPath, runPath, config, context, surface, inspect };
}

test("canonical session establishes source metadata without an invented outcome", (t) => {
  const f = fixture(t);
  const result = f.inspect();
  assert.equal(result.status, "verified");
  assert.equal(result.reason, null);
  assert.equal(result.task_project_id, "task_project");
  assert.equal(result.retrieval_workspace_id, "task_project");
  assert.equal(result.workspace_relation, "same_workspace");
  assert.equal(result.session.ref, SESSION);
  assert.equal(result.session.id, path.basename(SESSION, ".json"));
  assert.equal(result.session.thread_ref, THREAD);
  assert.match(result.session.sha256, /^[a-f0-9]{64}$/);
  assert.equal(result.run, null);
  const telemetry = buildOpportunity({ projectConfig: f.config, context: f.context, taskPacket: TASK, now: NOW, sourceMapPath: f.sourceMapPath });
  assert.equal(telemetry.schema_version, 2);
  assert.equal(validateTelemetry(telemetry), telemetry);
});

test("explicit session file supplies only canonical source identity and preserves caller context", (t) => {
  const f = fixture(t);
  const resolve = (context = {}) => contextFromSessionFile({ sessionFile: f.sessionPath, projectConfig: f.config,
    context, sourceMapPath: f.sourceMapPath, now: NOW });
  assert.deepEqual(resolve({ lane: "diagnostic" }), { lane: "diagnostic", session_ref: SESSION, thread_ref: THREAD });
  assert.deepEqual(resolve(f.context), f.context);
  for (const context of [{ session_ref: "session_bare" }, { thread_ref: "other_thread" }]) {
    assert.throws(() => resolve(context), { code: "session_file_context_conflict" });
  }
  write(f.sessionPath, { ...read(f.sessionPath), thread_ref: null });
  assert.equal(resolve().thread_ref, null);
  assert.throws(() => resolve({ thread_ref: THREAD }), { code: "session_file_context_conflict" });
  assert.equal(fs.existsSync(f.surface.artifactRoot), false);
});

test("session file rejects aliases, outside-owner files, malformed sources and undeclared cross-workspace context", (t) => {
  const f = fixture(t, { workspaceId: "other_project" });
  const resolve = (sessionFile = f.sessionPath, context = { task_workspace_relation: "cross_workspace" }) =>
    contextFromSessionFile({ sessionFile, projectConfig: f.config, context, sourceMapPath: f.sourceMapPath, now: NOW });
  assert.equal(resolve().session_ref, SESSION);
  assert.throws(() => resolve(f.sessionPath, {}), { code: "cross_workspace_relation_not_declared" });
  for (const input of [SESSION, f.sessionPath.replace("/09/", "/09/../09/"), `file://${f.sessionPath}`]) {
    assert.throws(() => resolve(input), { code: "session_file_not_canonical" });
  }
  assert.throws(() => resolve(path.join(f.root, SESSION)), { code: "session_file_outside_owner_layout" });
  const original = read(f.sessionPath);
  write(f.sessionPath, { ...original, id: "session_wrong" });
  assert.throws(() => resolve(), { code: "session_identity_invalid" });
  write(f.sessionPath, { ...original, project_id: "unregistered" });
  assert.throws(() => resolve(), { code: "session_project_not_registered" });
  fs.writeFileSync(f.sessionPath, "{malformed");
  assert.throws(() => resolve(), { code: "session_invalid_json" });
  fs.writeFileSync(f.sessionPath, "x".repeat(SOURCE_LIMIT_BYTES + 1));
  assert.throws(() => resolve(), { code: "session_input_budget_exceeded" });
  write(f.sessionPath, original);
  fs.renameSync(f.sessionPath, `${f.sessionPath}.real`);
  fs.symlinkSync(`${f.sessionPath}.real`, f.sessionPath);
  assert.throws(() => resolve(), { code: "session_path_not_canonical" });
  assert.equal(fs.existsSync(f.surface.artifactRoot), false);
});

test("missing context and bare or aliased references never become exact", (t) => {
  const f = fixture(t);
  assert.equal(f.inspect({ session_ref: null }).status, "absent");
  for (const ref of [path.basename(SESSION, ".json"), `./${SESSION}`, SESSION.replace("/sessions/", "/sessions/../sessions/"),
    f.sessionPath, `file://${f.sessionPath}`, SESSION.replace("/09/", "/13/")]) {
    assert.deepEqual([f.inspect({ session_ref: ref }).status, f.inspect({ session_ref: ref }).reason], ["invalid", "session_ref_not_canonical"]);
  }
  fs.unlinkSync(f.sessionPath);
  assert.deepEqual([f.inspect().status, f.inspect().reason], ["unresolved", "session_unavailable"]);
});

test("cross-workspace attribution preserves both identities and requires only an explicit relation", (t) => {
  const f = fixture(t, { workspaceId: "retrieval_project" });
  const missing = f.inspect();
  assert.equal(missing.status, "unresolved");
  assert.equal(missing.reason, "cross_workspace_relation_not_declared");
  const result = f.inspect({ task_workspace_relation: "cross_workspace" });
  assert.equal(result.status, "verified");
  assert.equal(result.task_project_id, "task_project");
  assert.equal(result.retrieval_workspace_id, "retrieval_project");
  assert.equal(result.workspace_relation, "cross_workspace");
  assert.equal(f.inspect({ task_workspace_relation: "same_workspace" }).status, "invalid");
  const options = {};
  assert.equal(readTelemetryOption(options, "--task-workspace-relation", "cross_workspace"), true);
  assert.equal(options.telemetryContext.task_workspace_relation, "cross_workspace");
  assert.throws(() => readTelemetryOption({}, "--task-workspace-relation", "guess"), { code: "invalid_telemetry_workspace_relation" });
});

test("literal source ID, project and thread assertions retain conflicts and missingness", (t) => {
  const f = fixture(t);
  assert.equal(f.inspect({ thread_ref: "codex-thread://other" }).reason, "session_thread_ref_conflict");
  const session = read(f.sessionPath);
  write(f.sessionPath, { ...session, thread_ref: null });
  assert.equal(f.inspect().status, "unresolved");
  assert.equal(f.inspect({ thread_ref: null }).status, "verified");
  assert.equal(f.inspect({ thread_ref: null }).session.thread_ref, null);
  write(f.sessionPath, { ...session, id: "different" });
  assert.equal(f.inspect().reason, "session_identity_invalid");
  write(f.sessionPath, { ...session, project_id: " task_project" });
  assert.equal(f.inspect().reason, "session_project_not_registered");
  write(f.sessionPath, session);
  write(f.registryPath, { projects: [{ id: "task_project" }, { id: "task_project" }] });
  assert.equal(f.inspect().reason, "session_project_ambiguous");
});

test("run evidence is optional and supplied references must be reciprocal", (t) => {
  const f = fixture(t);
  const session = read(f.sessionPath);
  write(f.runPath, { id: path.basename(RUN, ".json"), project_id: "task_project", session_ref: SESSION, thread_ref: THREAD });
  assert.equal(f.inspect({ run_ref: RUN }).reason, "session_run_ref_unavailable");
  write(f.sessionPath, { ...session, status: "closed", run_ref: RUN });
  assert.equal(f.inspect().run, null);
  assert.equal(f.inspect({ run_ref: RUN }).status, "verified");
  assert.equal(f.inspect({ run_ref: RUN }).run.session_ref, SESSION);
  write(f.runPath, { ...read(f.runPath), project_id: "other_project" });
  assert.equal(f.inspect({ run_ref: RUN }).reason, "run_identity_conflict");
  assert.equal(f.inspect({ run_ref: path.basename(RUN, ".json") }).reason, "run_ref_not_canonical");
});

test("bounded source reads reject malformed, oversized, nonregular and symlinked paths", (t) => {
  const f = fixture(t);
  const original = fs.readFileSync(f.sessionPath);
  for (const bytes of [Buffer.from("{"), Buffer.from([0xff])]) {
    fs.writeFileSync(f.sessionPath, bytes);
    assert.equal(f.inspect().reason, "session_invalid_json");
  }
  fs.writeFileSync(f.sessionPath, Buffer.alloc(SOURCE_LIMIT_BYTES + 1, 32));
  assert.equal(f.inspect().reason, "session_input_budget_exceeded");
  fs.unlinkSync(f.sessionPath);
  fs.mkdirSync(f.sessionPath);
  assert.equal(f.inspect().reason, "session_not_regular");
  fs.rmdirSync(f.sessionPath);
  execFileSync("mkfifo", [f.sessionPath]);
  assert.equal(f.inspect().reason, "session_not_regular");
  fs.unlinkSync(f.sessionPath);
  const outside = path.join(f.root, "outside.json");
  fs.writeFileSync(outside, original);
  fs.symlinkSync(outside, f.sessionPath);
  assert.equal(f.inspect().reason, "session_path_not_canonical");
  fs.unlinkSync(f.sessionPath);
  fs.writeFileSync(f.sessionPath, original);
  const month = path.dirname(f.sessionPath);
  fs.renameSync(month, `${month}-real`);
  fs.symlinkSync(`${month}-real`, month);
  assert.equal(f.inspect().reason, "session_path_not_canonical");
});

test("source metadata changing during capture is unresolved", (t) => {
  const f = fixture(t);
  const originalRead = fs.readSync;
  let changed = false;
  fs.readSync = function (...args) {
    const count = originalRead.apply(this, args);
    if (!changed && count > 0 && args[1].subarray(0, count).includes(Buffer.from('"id":"session_'))) {
      changed = true;
      write(f.sessionPath, { ...read(f.sessionPath), status: "closed", run_ref: RUN });
    }
    return count;
  };
  try { assert.equal(f.inspect().status, "unresolved"); }
  finally { fs.readSync = originalRead; }
  assert.equal(changed, true);
});

test("anchor reuse checks binding before mutation and tolerates ordinary source closeout", async (t) => {
  const f = fixture(t);
  const args = { taskPacket: TASK, telemetryContext: f.context, query: "source identity", now: NOW };
  const anchor = f.surface.beginTaskOpportunity(args);
  const bytes = fs.readFileSync(anchor.artifact_path);
  assert.throws(() => f.surface.beginTaskOpportunity({ ...args, telemetryContext: { ...f.context, thread_ref: "other" } }), { code: "opportunity_context_conflict" });
  assert.throws(() => f.surface.beginTaskOpportunity({ ...args, telemetryContext: { ...f.context, session_ref: SESSION.replace("fixture", "other") } }), { code: "opportunity_context_conflict" });
  await assert.rejects(f.surface.executeConsultation({ ...args, opportunity: anchor, telemetryContext: { ...f.context, episode_id: "different" }, execute: async () => ({}) }), { code: "opportunity_context_conflict" });
  assert.deepEqual(fs.readFileSync(anchor.artifact_path), bytes);
  write(f.runPath, { id: path.basename(RUN, ".json"), project_id: "task_project", session_ref: SESSION, thread_ref: THREAD });
  write(f.sessionPath, { ...read(f.sessionPath), status: "closed", run_ref: RUN });
  assert.equal(f.surface.beginTaskOpportunity({ ...args, telemetryContext: { ...f.context, run_ref: RUN } }).invocation_id, anchor.invocation_id);
  assert.deepEqual(fs.readFileSync(anchor.artifact_path), bytes);
  write(f.sessionPath, { ...read(f.sessionPath), thread_ref: "other_source_thread" });
  assert.throws(() => f.surface.beginTaskOpportunity(args), { code: "opportunity_session_identity_changed" });
  assert.deepEqual(fs.readFileSync(anchor.artifact_path), bytes);
});

test("historical v1 anchors stay readable, byte-preserved on reuse, and attribution-unverified", (t) => {
  const f = fixture(t);
  const args = { taskPacket: TASK, telemetryContext: f.context, query: "source identity", now: NOW };
  const anchor = f.surface.beginTaskOpportunity(args);
  const historical = read(anchor.artifact_path);
  historical.telemetry.schema_version = 1;
  delete historical.telemetry.opportunity.attribution;
  delete historical.telemetry.opportunity.binding.task_workspace_relation;
  write(anchor.artifact_path, historical);
  const bytes = fs.readFileSync(anchor.artifact_path);
  assert.equal(validateTelemetry(historical.telemetry), historical.telemetry);
  f.surface.beginTaskOpportunity(args);
  assert.deepEqual(fs.readFileSync(anchor.artifact_path), bytes);
  const report = summarizeTelemetryArtifacts([historical]);
  assert.equal(report.declared_lifecycle_task_opportunities, 1);
  assert.equal(report.joined_task_opportunities, 0);
  assert.equal(report.episode_attribution.by_status.legacy_unverified, 1);
});

test("report counts verified attribution separately from invalid references and conflicting snapshots", (t) => {
  const f = fixture(t);
  f.surface.logTaskOpportunity({ taskPacket: TASK, telemetryContext: f.context, query: "same source" });
  f.surface.logTaskOpportunity({ taskPacket: { ...TASK, task_id: "bare_id" }, telemetryContext: { session_ref: "session_bare" }, query: "bare source" });
  f.surface.logTaskOpportunity({ taskPacket: { ...TASK, task_id: "absent_id" }, telemetryContext: {}, query: "absent source" });
  const artifacts = loadMemoryInvocationArtifacts({ artifactRoot: f.surface.artifactRoot });
  const report = summarizeTelemetryArtifacts(artifacts);
  assert.equal(report.report_schema_version, 3);
  assert.equal(report.joined_task_opportunities, 1);
  assert.equal(report.unjoined_task_opportunities, 2);
  assert.equal(report.episode_attribution.by_status.invalid, 1);
  assert.equal(report.episode_attribution.by_status.absent, 1);
  const original = artifacts.find((entry) => entry.telemetry.opportunity.attribution.status === "verified");
  const altered = structuredClone(original);
  altered.telemetry.opportunity.attribution.session.sha256 = "f".repeat(64);
  const conflicted = summarizeTelemetryArtifacts([original, altered]);
  assert.equal(conflicted.joined_task_opportunities, 0);
  assert.equal(conflicted.conflicting_deliveries.length, 1);
});
