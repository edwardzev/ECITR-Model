const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const exec = promisify(execFile);
const { ProjectMemorySurface, createProjectMemoryRetrievalRuntime, loadMemoryInvocationArtifacts, summarizeMemoryInvocations } = require("../src/runtime/project-memory");
const { buildOpportunity, validateTelemetry } = require("../src/runtime/project-memory-telemetry");
const { summarizeTelemetryArtifacts } = require("../src/runtime/project-memory-telemetry-report");
const { structuralHash } = require("../src/runtime/project-memory-reader");
const { FileBackedCatalog } = require("../src/storage/file-backed-catalog");
const { OrchestratorExecutionLoop } = require("../src/orchestrator/execution-loop");
const { loadEcitrProjectConfig } = require("../src/workspace/config");
const { loadExample } = require("./helpers/load-example");

const QUERY = "scope filter ranking project retrieval";
const TASK = { task_id: "literal_task_001", title: "Known project decision" };
const CONTEXT = { episode_id: "episode_1", session_ref: "session_literal", thread_ref: "codex-thread://literal", lane: "governed-write" };
const CASE_ID = "case_retrieval_scope_drift_001";
const read = (ref) => JSON.parse(fs.readFileSync(ref, "utf8"));

function fixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-telemetry-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const marker = { ...loadExample("ecitr_project"), default_project_scope: "project_family", ...overrides.marker };
  fs.writeFileSync(path.join(root, "ecitr.project.json"), JSON.stringify(marker));
  const config = loadEcitrProjectConfig({ startDir: root });
  const catalog = new FileBackedCatalog({ rootDir: config.catalog_root });
  if (overrides.records !== false) for (const type of ["evidence", "case", "invariant", "tactic", "atomic_claim_set"]) catalog.writeRecord(type, loadExample(type));
  const surface = new ProjectMemorySurface({ catalog, projectConfig: config,
    retrievalRuntime: overrides.retrievalRuntime ?? createProjectMemoryRetrievalRuntime({ responseEnricher: null }),
    ...overrides.surface });
  return { root, config, catalog, surface };
}

function search(f, extras = {}) {
  return f.surface.searchProjectMemory({ query: QUERY, taskPacket: TASK, telemetryContext: CONTEXT, ...extras });
}

test("stable declared lifecycle identity does not imply verified episode attribution", (t) => {
  const f = fixture(t, { records: false });
  const build = (context, config = f.config, taskPacket = TASK) => buildOpportunity({ projectConfig: config, taskPacket, context, now: new Date("2026-09-12T00:00:00Z") }).opportunity;
  const first = build(CONTEXT);
  assert.equal(first.opportunity_id, build({ ...CONTEXT, run_ref: "later_run", thread_ref: "different_literal" }).opportunity_id);
  assert.equal(first.identity_basis, "episode_id");
  assert.equal(first.binding.thread_ref, "codex-thread://literal");
  assert.equal(first.attribution.status, "invalid");
  assert.notEqual(first.opportunity_id, build({ ...CONTEXT, episode_id: "episode_2" }).opportunity_id);
  assert.notEqual(first.opportunity_id, build(CONTEXT, { ...f.config, workspace_id: "other" }).opportunity_id);
  assert.notEqual(first.opportunity_id, build(CONTEXT, { ...f.config, catalog_root: "/other/catalog" }).opportunity_id);
  assert.notEqual(first.opportunity_id, build(CONTEXT, f.config, { ...TASK, task_id: "other" }).opportunity_id);
  assert.equal(build({ session_ref: "s", run_ref: "r" }).identity_basis, "session_ref");
  assert.equal(build({ run_ref: "r" }).identity_basis, "run_ref");
  assert.equal(build({ thread_ref: "thread_only" }).identity_basis, "unjoined_boundary");
  assert.notEqual(build({}).opportunity_id, build({}).opportunity_id);
  assert.equal(build({}).binding.session_ref, null);
  assert.equal(build({}).missing_context.session_ref, "not_supplied");
});

test("direct lifecycle records a pending shadow gate before internal dispatch without claiming the external choice", async (t) => {
  const f = fixture(t);
  let calls = 0;
  const evaluate = f.surface.retrievalGate.evaluate.bind(f.surface.retrievalGate);
  f.surface.retrievalGate.evaluate = (args) => { calls += 1; return evaluate(args); };
  const opportunity = f.surface.beginTaskOpportunity({ taskPacket: TASK, telemetryContext: CONTEXT, query: QUERY });
  const pending = read(opportunity.artifact_path);
  assert.equal(pending.telemetry.opportunity.decision, "pending");
  assert.equal(pending.telemetry.opportunity.capture_boundary, "caller_selected_before_dispatch");
  assert.equal(pending.telemetry.attempt, null);
  assert.equal(pending.telemetry.opportunity.gate_observation.evaluation.mode, "shadow");
  assert.equal(pending.telemetry.opportunity.gate_observation.evaluation.actual_behavior, undefined);
  const result = await search(f);
  assert.equal(result.memory_invocation.invocation_id, opportunity.invocation_id);
  assert.equal(calls, 1);
  assert.equal(result.memory_invocation.attempt.status, "succeeded");
  const artifact = read(result.memory_invocation.artifact_path);
  assert.equal(validateTelemetry(artifact.telemetry), artifact.telemetry);
  assert.equal(artifact.retrieval_gate.actual_behavior, "retrieve_always");
  assert.equal(artifact.telemetry.attempt.semantic_backend.value, "heuristic-semantic-v2");
  assert.match(artifact.telemetry.attempt.corpus_sha256.value, /^sha256:[a-f0-9]{64}$/);
  assert.equal(artifact.telemetry.attempt.index_basis_sha256.reason, "no_derived_index_selected");
});

test("caller-selected skip has a shadow gate, a reason and zero attempts; duplicate skip preserves the anchor", (t) => {
  const f = fixture(t, { records: false });
  const context = { ...CONTEXT, decision_reason: "Current source already supplies the answer" };
  const first = f.surface.logTaskOpportunity({ taskPacket: TASK, telemetryContext: context, query: "What is computer memory?", now: new Date("2026-08-31T23:59:59Z") });
  const bytes = fs.readFileSync(first.artifact_path);
  const again = f.surface.logTaskOpportunity({ taskPacket: TASK, telemetryContext: context, query: "What is computer memory?", now: new Date("2026-09-01T00:00:01Z") });
  assert.equal(first.invocation_id, again.invocation_id);
  assert.equal(first.artifact_path, again.artifact_path);
  assert.deepEqual(fs.readFileSync(first.artifact_path), bytes);
  const report = summarizeMemoryInvocations({ artifactRoot: f.surface.artifactRoot });
  assert.equal(report.task_opportunities, 1);
  assert.equal(report.retrieval_attempts, 0);
  assert.equal(report.shadow_gate.pre_decision_observations, 0);
  assert.equal(report.shadow_gate.caller_selected_before_dispatch_observations, 1);
  assert.equal(report.shadow_gate.proposed_skips, 1);
  assert.equal(read(first.artifact_path).retrieval_gate.actual_behavior, "not_consulted");
});

test("contradictory consult and skip decisions fail instead of double-counting one episode", async (t) => {
  const f = fixture(t);
  const result = await search(f);
  const original = fs.readFileSync(result.memory_invocation.artifact_path);
  assert.throws(() => f.surface.logTaskOpportunity({ taskPacket: TASK, telemetryContext: CONTEXT }), { code: "opportunity_decision_conflict" });
  assert.deepEqual(fs.readFileSync(result.memory_invocation.artifact_path), original);
});

for (const [marker, trigger] of [
  [{ preflight_retrieval_mandatory: true }, "preflight"],
  [{ failure_retry_retrieval_mandatory: true }, "failure_retry"],
]) test(`mandatory ${trigger} forbids skip and retains a blocked opportunity`, (t) => {
  const f = fixture(t, { marker, records: false });
  assert.throws(() => f.surface.logTaskOpportunity({ taskPacket: TASK, telemetryContext: CONTEXT, query: "What is computer memory?", trigger }), { code: "mandatory_retrieval_required" });
  const artifacts = loadMemoryInvocationArtifacts({ artifactRoot: f.surface.artifactRoot });
  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0].telemetry.opportunity.decision, "blocked");
  assert.equal(artifacts[0].telemetry.opportunity.gate_observation.evaluation.decision, "retrieve");
  assert.equal(artifacts[0].telemetry.opportunity.gate_observation.evaluation.mandatory_override, true);
});

for (const context of [{ lane: "micro" }, { audit_mode: "strict_no_write" }, { audit_mode: "strict no-write audit" }]) {
  test(`excluded context ${JSON.stringify(context)} creates no invocation artifacts`, async (t) => {
    const f = fixture(t, { records: false });
    assert.equal(f.surface.logTaskOpportunity({ taskPacket: TASK, telemetryContext: context }), null);
    await assert.rejects(search(f, { telemetryContext: context }), { code: "memory_telemetry_excluded" });
    assert.equal(fs.existsSync(f.surface.artifactRoot), false);
  });
}

test("catalog failure remains visible with bounded metadata and monotonic duration", async (t) => {
  let clock = 0;
  const f = fixture(t, { records: false, surface: { monotonicNow: () => ++clock } });
  f.catalog.loadRuntimeCatalogs = () => { throw new Error("PRIVATE_BODY_MUST_NOT_PERSIST"); };
  await assert.rejects(search(f), (error) => {
    const artifact = read(error.memory_invocation.artifact_path);
    assert.equal(artifact.telemetry.attempt.status, "failed");
    assert.equal(artifact.telemetry.attempt.error_code, "retrieval_failed");
    assert.ok(artifact.telemetry.attempt.duration_ms > 0);
    assert.equal(artifact.telemetry.attempt.phases_ms.catalog_load.value, 1);
    assert.equal(artifact.telemetry.attempt.corpus_sha256.value, null);
    assert.equal(artifact.telemetry.attempt.model_usage.value, null);
    assert.equal(JSON.stringify(artifact).includes("PRIVATE_BODY_MUST_NOT_PERSIST"), false);
    return true;
  });
});

test("retrieval failure retains catalog identity and retry is a distinct attempt with the same opportunity", async (t) => {
  let calls = 0;
  const realRuntime = createProjectMemoryRetrievalRuntime({ responseEnricher: null });
  const f = fixture(t, { retrievalRuntime: { async execute(args) { if (++calls === 1) throw new Error("backend failed"); return realRuntime.execute(args); } } });
  let failed;
  await assert.rejects(search(f), (error) => { failed = error.memory_invocation; return true; });
  assert.match(read(failed.artifact_path).telemetry.attempt.corpus_sha256.value, /^sha256:/);
  const recovered = await search(f, { trigger: "failure_retry", telemetryContext: { ...CONTEXT, retry_of: failed.attempt.attempt_id } });
  assert.equal(recovered.memory_invocation.opportunity_id, failed.opportunity_id);
  assert.notEqual(recovered.memory_invocation.invocation_id, failed.invocation_id);
  assert.equal(read(failed.artifact_path).telemetry.attempt.status, "failed");
  const report = summarizeMemoryInvocations({ artifactRoot: f.surface.artifactRoot });
  assert.equal(report.task_opportunities, 1);
  assert.equal(report.retrieval_attempts, 2);
  assert.equal(report.declared_retries, 1);
  assert.equal(report.attempts_by_status.failed, 1);
  assert.equal(report.attempts_by_status.succeeded, 1);
  assert.deepEqual(report.orphaned_retry_refs_in_loaded_population, []);
});

test("observed cancellation and missing terminal are different states", async (t) => {
  let release;
  const f = fixture(t, { retrievalRuntime: { execute() { return new Promise((resolve) => { release = () => resolve({ response: { results: {} } }); }); } } });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(search(f, { signal: controller.signal }), { code: "retrieval_cancelled" });
  const inFlight = search(f, { telemetryContext: { ...CONTEXT, episode_id: "pending_episode" } });
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  const report = summarizeMemoryInvocations({ artifactRoot: f.surface.artifactRoot });
  assert.equal(report.attempts_by_status.cancelled, 1);
  assert.equal(report.missing_terminal_events, 1);
  assert.equal(report.attempts_by_status.failed, 0);
  release(); await inFlight;
});

test("concurrent searches share one opportunity and retain each attempt and its read/usage updates", async (t) => {
  const f = fixture(t);
  const [first, second] = await Promise.all([search(f), search(f)]);
  assert.equal(first.memory_invocation.opportunity_id, second.memory_invocation.opportunity_id);
  assert.notEqual(first.memory_invocation.invocation_id, second.memory_invocation.invocation_id);
  for (const result of [first, second]) {
    f.surface.readProjectMemoryRecords({ invocationId: result.memory_invocation.invocation_id, recordIds: [CASE_ID] });
    f.surface.recordMemoryUsage({ invocationId: result.memory_invocation.invocation_id, usedRecordIds: [CASE_ID] });
  }
  const artifacts = loadMemoryInvocationArtifacts({ artifactRoot: f.surface.artifactRoot });
  assert.equal(artifacts.filter((entry) => entry.invocation_id.startsWith("meminv_opportunity_")).length, 1);
  assert.equal(artifacts.length, 2);
  assert.ok(artifacts.every((entry) => entry.read_receipts.length === 1 && entry.used_memory === true));
  const report = summarizeTelemetryArtifacts([...artifacts, structuredClone(artifacts[0])]);
  assert.equal(report.duplicate_deliveries, 1);
  assert.equal(report.task_opportunities, 1);
  assert.equal(report.retrieval_attempts, 2);
  assert.equal(report.usage_callbacks, 2);
  assert.equal(report.use_stages.reported_use_callbacks_without_complete_references, 2);
  assert.deepEqual(report.use_stages.reported_used_record_ids_without_references, [CASE_ID]);
});

test("concurrent caller-selected processes atomically create one cross-day anchor without duplicate gate observations", async (t) => {
  const f = fixture(t, { records: false });
  const source = `const {ProjectMemorySurface}=require(${JSON.stringify(path.resolve(__dirname, '../src/runtime/project-memory'))});
const {loadEcitrProjectConfig}=require(${JSON.stringify(path.resolve(__dirname, '../src/workspace/config'))});
const surface=new ProjectMemorySurface({projectConfig:loadEcitrProjectConfig({startDir:process.argv[1]})});
process.stdout.write(JSON.stringify(surface.logTaskOpportunity({taskPacket:${JSON.stringify(TASK)},telemetryContext:${JSON.stringify(CONTEXT)},now:new Date(process.argv[2])})));`;
  const results = await Promise.all([0, 1, 2, 3].map((index) => exec(process.execPath, ["-e", source, f.root, `2026-09-${12 + index}T00:00:00Z`])));
  assert.equal(new Set(results.map((result) => JSON.parse(result.stdout).invocation_id)).size, 1);
  const report = summarizeMemoryInvocations({ artifactRoot: f.surface.artifactRoot });
  assert.equal(report.recorded_invocations, 1);
  assert.equal(report.shadow_gate.pre_decision_observations, 0);
  assert.equal(report.shadow_gate.caller_selected_before_dispatch_observations, 1);
});

test("usage distinguishes preparation, inspection, declarations and missing or empty callbacks", async (t) => {
  const f = fixture(t);
  const first = await search(f);
  const id = first.memory_invocation.invocation_id;
  f.surface.readProjectMemoryRecords({ invocationId: id, recordIds: [CASE_ID] });
  f.surface.recordMemoryUsage({ invocationId: id, usedRecordIds: [CASE_ID], inspectedRecordIds: [CASE_ID],
    useEvidence: [{ record_id: CASE_ID, output_ref: "fixture-output.json", support_ref: "independent-review.json", reviewer_ref: "reviewer_2" }] });
  const second = await search(f, { telemetryContext: { ...CONTEXT, episode_id: "empty_callback" } });
  f.surface.recordMemoryUsage({ invocationId: second.memory_invocation.invocation_id });
  await search(f, { telemetryContext: { ...CONTEXT, episode_id: "missing_callback" } });
  const report = summarizeMemoryInvocations({ artifactRoot: f.surface.artifactRoot });
  assert.equal(report.explicit_empty_callbacks, 1);
  assert.equal(report.missing_callbacks, 1);
  assert.equal(report.reported_no_influence_callbacks, 1);
  assert.deepEqual(report.use_stages.prepared_record_ids, [CASE_ID]);
  assert.deepEqual(report.use_stages.reported_inspected_record_ids, [CASE_ID]);
  assert.deepEqual(report.use_stages.reported_used_record_ids, [CASE_ID]);
  assert.equal(report.use_stages.evidence_link_declarations, 1);
  assert.equal(report.use_stages.reported_use_callbacks_without_complete_references, 0);
  assert.deepEqual(report.use_stages.reported_used_record_ids_without_references, []);
  assert.deepEqual(report.use_stages.reported_use_reference_coverage, { callbacks_with_complete_references: 1, reported_use_callbacks: 1 });
  assert.equal(report.use_stages.independently_corroborated_use.value, null);
  assert.equal(report.use_stages.measured_benefit.value, null);
  assert.throws(() => f.surface.recordMemoryUsage({ invocationId: id, usedRecordIds: [CASE_ID],
    useEvidence: [{ record_id: CASE_ID, output_ref: "out", corroboration: "verified" }] }), { code: "invalid_use_evidence" });
  assert.throws(() => f.surface.recordMemoryUsage({ invocationId: id,
    useEvidence: [{ record_id: "case_unreturned", output_ref: "out" }] }), { code: "use_evidence_record_not_used" });
});

test("legacy callbacks stay readable with an explicit unknown task denominator", () => {
  const legacy = { schema_version: 1, invocation_id: "meminv_legacy", workspace_id: "old", memory_consulted: true,
    usage_recorded_at: "2026-01-01T00:00:00Z", used_memory: true, used_record_ids: ["case_old"] };
  const bytes = JSON.stringify(legacy);
  const report = summarizeTelemetryArtifacts([legacy, structuredClone(legacy)]);
  assert.equal(report.recorded_invocations, 1);
  assert.equal(report.task_opportunities, 0);
  assert.equal(report.consultation_rate, null);
  assert.equal(report.coverage.legacy_artifacts, 1);
  assert.equal(report.coverage.legacy_task_opportunities.value, null);
  assert.equal(report.legacy_compatibility.task_opportunities, 1);
  assert.deepEqual(report.used_record_ids, ["case_old"]);
  assert.equal(JSON.stringify(legacy), bytes);
});

test("population coverage requires a versioned exact-context hash and exposes missing and orphaned IDs", async (t) => {
  const f = fixture(t);
  const result = await search(f);
  const member = { workspace_id: f.config.workspace_id, catalog_root: f.config.catalog_root, opportunity_id: result.memory_invocation.opportunity_id };
  const missing = { ...member, opportunity_id: `memopp_${"0".repeat(64)}` };
  const entries = [member, missing];
  const population = { schema_version: 1, enumeration_ref: "independent-fixture-manifest.json", opportunities: entries, sha256: structuralHash(entries) };
  const report = summarizeMemoryInvocations({ artifactRoot: f.surface.artifactRoot, eligiblePopulation: population });
  assert.equal(report.coverage.eligible_population.value, 2);
  assert.equal(report.coverage.observed_eligible_opportunities, 1);
  assert.equal(report.coverage.missing_eligible_opportunities.length, 1);
  assert.equal(report.coverage.independence.value, null);
  const other = [{ ...member, catalog_root: "/different/catalog" }];
  const mismatch = summarizeMemoryInvocations({ artifactRoot: f.surface.artifactRoot, eligiblePopulation: { ...population, opportunities: other, sha256: structuralHash(other) } });
  assert.equal(mismatch.coverage.observed_eligible_opportunities, 0);
  assert.equal(mismatch.coverage.orphaned_recorded_opportunities.length, 1);
  assert.throws(() => summarizeMemoryInvocations({ artifactRoot: f.surface.artifactRoot, eligiblePopulation: { ...population, sha256: "wrong" } }), { code: "invalid_eligible_population" });
});

test("normal execution-loop consult and skip both produce pre-decision observations", async (t) => {
  const f = fixture(t);
  const loop = new OrchestratorExecutionLoop({ catalog: f.catalog, projectMemorySurface: f.surface, retrievalRuntime: f.surface.retrievalRuntime });
  const task = loadExample("orchestrator_task_packet");
  await loop.run({ taskPacket: task, telemetryContext: CONTEXT });
  const explicit = await loop.run({ taskPacket: task, retrievalRequest: loadExample("retrieval_request"), telemetryContext: { ...CONTEXT, episode_id: "consult_episode" } });
  assert.equal(explicit.memory_invocation.consult_trigger, "explicit_request");
  assert.equal(explicit.memory_invocation.attempt.trigger, "explicit_request");
  assert.equal(explicit.retrieval_gate.mandatory_policy.trigger, "discretionary");
  const report = summarizeMemoryInvocations({ artifactRoot: f.surface.artifactRoot });
  assert.equal(report.shadow_gate.pre_decision_observations, 2);
  assert.equal(report.shadow_gate.pre_decision_scope, "instrumented_executor_choice_only");
  assert.equal(report.shadow_gate.caller_selected_before_dispatch_observations, 0);
  assert.equal(report.shadow_gate.external_agent_choice_coverage.value, null);
  assert.equal(report.opportunities_by_decision.skip, 1);
  assert.equal(report.opportunities_by_decision.consult, 1);
});

test("CLI failure after marker resolution produces an attempt; missing marker exposes a capture gap without writes", async (t) => {
  const f = fixture(t, { records: false });
  const cli = path.resolve(__dirname, "../src/cli/search-project-memory.js");
  await assert.rejects(exec(process.execPath, [cli, "--workspace-root", f.root, "--task-id", TASK.task_id, "--session-ref", "s"]), (error) => {
    const output = JSON.parse(error.stderr);
    assert.equal(output.error, "retrieval_failed");
    assert.equal(output.capture_gap, null);
    assert.equal(read(output.memory_invocation.artifact_path).telemetry.attempt.status, "failed");
    return true;
  });
  const unmarked = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-unmarked-"));
  t.after(() => fs.rmSync(unmarked, { recursive: true, force: true }));
  await assert.rejects(exec(process.execPath, [cli, "--workspace-root", unmarked, "--workspace-id", "fixture", "--catalog-root", path.join(unmarked, "catalog"), "--query", QUERY]), (error) => {
    assert.equal(JSON.parse(error.stderr).memory_invocation, null);
    assert.ok(JSON.parse(error.stderr).capture_gap);
    return true;
  });
  assert.deepEqual(fs.readdirSync(unmarked), []);
});

test("duplicate delivery conflict quarantine preserves known progress but never chooses contradictory terminal or usage facts", async (t) => {
  const f = fixture(t);
  const initial = f.surface.beginTaskOpportunity({ taskPacket: TASK, telemetryContext: CONTEXT, query: QUERY });
  const pending = read(initial.artifact_path);
  const result = await search(f);
  const terminal = read(result.memory_invocation.artifact_path);
  const progressed = summarizeTelemetryArtifacts([terminal, pending, structuredClone(terminal)]);
  assert.equal(progressed.task_opportunities, 1);
  assert.equal(progressed.attempts_by_status.succeeded, 1);
  assert.deepEqual(progressed.conflicting_deliveries, []);
  const contradictory = structuredClone(terminal);
  contradictory.telemetry.attempt.status = "failed";
  contradictory.telemetry.attempt.error_code = "retrieval_failed";
  contradictory.telemetry.attempt.finished_at = "2099-01-01T00:00:00.000Z";
  const ambiguous = summarizeTelemetryArtifacts([terminal, contradictory]);
  assert.equal(ambiguous.retrieval_attempts, 0);
  assert.equal(ambiguous.task_opportunities, 0);
  assert.ok(ambiguous.conflicting_deliveries[0].reasons.includes("terminal_attempt_conflict"));
  f.surface.recordMemoryUsage({ invocationId: result.memory_invocation.invocation_id, usedRecordIds: [CASE_ID] });
  const usage = read(result.memory_invocation.artifact_path);
  const changed = structuredClone(usage); changed.used_memory = false; changed.used_record_ids = []; changed.used_returned_record_ids = [];
  const incompatible = summarizeTelemetryArtifacts([usage, changed]);
  assert.equal(incompatible.used_memory, 0);
  assert.ok(incompatible.conflicting_deliveries[0].reasons.includes("usage_callback_conflict"));
  const wrongIdentity = structuredClone(terminal); wrongIdentity.telemetry.opportunity.binding.session_ref = "different";
  assert.ok(summarizeTelemetryArtifacts([terminal, wrongIdentity]).conflicting_deliveries[0].reasons.includes("immutable_identity_conflict"));
  const wrongBoundary = structuredClone(terminal); wrongBoundary.telemetry.opportunity.capture_boundary = "before_decision";
  const boundaryConflict = summarizeTelemetryArtifacts([terminal, wrongBoundary]);
  assert.ok(boundaryConflict.conflicting_deliveries[0].reasons.includes("immutable_identity_conflict"));
  assert.equal(boundaryConflict.shadow_gate.pre_decision_observations, 0);
  wrongBoundary.invocation_id = "meminv_other_attempt";
  wrongBoundary.telemetry.attempt.invocation_id = wrongBoundary.invocation_id;
  wrongBoundary.telemetry.attempt.attempt_id = "memattempt_00000000-0000-0000-0000-000000000001";
  const opportunityConflict = summarizeTelemetryArtifacts([terminal, wrongBoundary]);
  assert.equal(opportunityConflict.coverage.conflicting_opportunity_capture_boundaries, 1);
  assert.equal(opportunityConflict.shadow_gate.pre_decision_observations, 0);
});

test("new telemetry schema rejects invented duration and unknown model usage on a running attempt", async (t) => {
  const f = fixture(t);
  const result = await search(f);
  const telemetry = read(result.memory_invocation.artifact_path).telemetry;
  const running = structuredClone(telemetry); running.attempt.status = "running";
  assert.throws(() => validateTelemetry(running), { code: "invalid_memory_telemetry" });
  const invented = structuredClone(telemetry); invented.attempt.actual_model = "guessed-default";
  assert.throws(() => validateTelemetry(invented), { code: "invalid_memory_telemetry" });
  const badMissingness = structuredClone(telemetry); badMissingness.attempt.cost = { value: null, reason: null };
  assert.throws(() => validateTelemetry(badMissingness), { code: "invalid_memory_telemetry" });
});

test("malformed and unsupported positive-use telemetry contributes no measured usage stage", async (t) => {
  const f = fixture(t);
  const result = await search(f);
  f.surface.recordMemoryUsage({ invocationId: result.memory_invocation.invocation_id, usedRecordIds: [CASE_ID], inspectedRecordIds: [CASE_ID] });
  const valid = read(result.memory_invocation.artifact_path);
  const malformed = structuredClone(valid); malformed.telemetry.attempt.status = "invented";
  const unsupported = structuredClone(valid); unsupported.invocation_id = "meminv_future"; unsupported.telemetry.schema_version = 99;
  const report = summarizeTelemetryArtifacts([malformed, unsupported]);
  assert.equal(report.coverage.malformed_telemetry_artifacts, 1);
  assert.equal(report.coverage.unsupported_telemetry_artifacts, 1);
  assert.equal(report.consultations, 0);
  assert.equal(report.usage_callbacks, 0);
  assert.equal(report.used_memory, 0);
  assert.deepEqual(report.use_stages.reported_used_record_ids, []);
  assert.deepEqual(report.use_stages.reported_inspected_record_ids, []);
});

test("direct search and no-consult gates are caller-selected observations, not before-agent-choice coverage", async (t) => {
  const f = fixture(t);
  await search(f);
  f.surface.logTaskOpportunity({ taskPacket: TASK, telemetryContext: { ...CONTEXT, episode_id: "skip_episode" }, query: "What is computer memory?" });
  const report = summarizeMemoryInvocations({ artifactRoot: f.surface.artifactRoot });
  assert.equal(report.task_opportunities, 2);
  assert.equal(report.shadow_gate.observed_opportunities, 2);
  assert.equal(report.shadow_gate.pre_decision_observations, 0);
  assert.equal(report.shadow_gate.caller_selected_before_dispatch_observations, 2);
  assert.equal(report.shadow_gate.missing_gate_observations, 0);
  assert.equal(report.shadow_gate.proposed_skips, 1);
  assert.equal(report.coverage.external_agent_choice_coverage.value, null);
  assert.equal(report.coverage.external_agent_choice_coverage.reason, "native_agent_decision_boundary_not_observed");
});

test("an executor call cannot retroactively promote an existing caller-selected anchor to pre-choice evidence", async (t) => {
  const f = fixture(t);
  const task = loadExample("orchestrator_task_packet");
  await search(f, { taskPacket: task });
  const loop = new OrchestratorExecutionLoop({ catalog: f.catalog, projectMemorySurface: f.surface, retrievalRuntime: f.surface.retrievalRuntime });
  await loop.run({ taskPacket: task, retrievalRequest: loadExample("retrieval_request"), telemetryContext: CONTEXT });
  const report = summarizeMemoryInvocations({ artifactRoot: f.surface.artifactRoot });
  assert.equal(report.task_opportunities, 1);
  assert.equal(report.retrieval_attempts, 2);
  assert.equal(report.shadow_gate.pre_decision_observations, 0);
  assert.equal(report.shadow_gate.caller_selected_before_dispatch_observations, 1);
});
