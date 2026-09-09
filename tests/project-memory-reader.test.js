const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn, spawnSync } = require("node:child_process");

const { FileBackedCatalog } = require("../src/storage/file-backed-catalog");
const { ProjectMemorySurface } = require("../src/runtime/project-memory");
const { READER_LIMITS, structuralHash } = require("../src/runtime/project-memory-reader");
const { OrchestratorExecutionLoop } = require("../src/orchestrator/execution-loop");
const { loadExample } = require("./helpers/load-example");

const REPO_ROOT = path.resolve(__dirname, "..");
const WRAPPER = path.join(REPO_ROOT, "integrations/codex/ecitr-memory/scripts/read_project_memory_records");
const NOW = new Date("2026-09-09T10:00:00.000Z");

function sha256(bytes) {
  return `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-selected-reader-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const catalogRoot = path.join(root, "catalog");
  writeJson(path.join(root, "ecitr.project.json"), {
    ...loadExample("ecitr_project"),
    catalog_root: "catalog",
    default_project_scope: "project_family",
  });
  const catalog = new FileBackedCatalog({ rootDir: catalogRoot });
  const payloadRef = "payloads/evidence/fixture/chat/2026/09/ev_reader.txt";
  const payload = Buffer.from("scope filter ranking\r\nשלום 💠 exact\r\nlast line\n", "utf8");
  fs.mkdirSync(path.dirname(path.join(catalogRoot, payloadRef)), { recursive: true });
  fs.writeFileSync(path.join(catalogRoot, payloadRef), payload);
  const records = Object.fromEntries(["evidence", "case", "invariant", "tactic"].map((type) => [type, loadExample(type)]));
  Object.assign(records.evidence, {
    source_locator: "fixture://scope-filter-ranking-project-retrieval",
    verbatim_payload_ref: payloadRef,
    payload_hash: sha256(payload),
    source_hash: "sha256:upstream-claim-not-independently-verified",
  });
  records.tactic.expiry_at = "2099-01-01T00:00:00Z";
  records.tactic.revalidate_at = "2099-01-01T00:00:00Z";
  for (const [type, record] of Object.entries(records)) catalog.writeRecord(type, record);
  const surface = new ProjectMemorySurface({ catalog });
  return {
    root, catalogRoot, catalog, records, surface, payload, payloadRef,
    env: {
      ...process.env,
      ECITR_MODEL_ROOT: REPO_ROOT,
      ECITR_LANCEDB_URI: path.join(root, "absent-derived-index"),
      ECITR_PROJECT_MEMORY_EMBEDDER: "hash",
    },
  };
}

function cli(f, script, args, extraEnv = {}) {
  return spawnSync(process.execPath, [path.join(REPO_ROOT, "src/cli", script), ...args], {
    cwd: f.root,
    env: { ...f.env, ...extraEnv },
    encoding: "utf8",
  });
}

function searchCli(f, args = []) {
  const result = cli(f, "search-project-memory.js", [
    "--catalog-root", f.catalogRoot,
    "--query", "scope filter ranking project retrieval",
    "--task-id", `task_reader_${crypto.randomUUID().replaceAll("-", "")}`,
    ...args,
  ]);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout).memory_invocation;
}

function readerArgs(invocation, ids, extra = []) {
  return ["--invocation-id", invocation.invocation_id, "--record-ids", ids.join(","), ...extra];
}

function readWrapper(f, invocation, ids, extra = [], extraEnv = {}) {
  return spawnSync(WRAPPER, readerArgs(invocation, ids, extra), {
    cwd: f.root, env: { ...f.env, ...extraEnv }, encoding: "utf8",
  });
}

function success(result) {
  assert.equal(result.status, 0, result.stderr);
  assert.equal(Buffer.byteLength(result.stdout.slice(0, -1)), Buffer.byteLength(result.stdout.trimEnd()), "only one final newline is emitted");
  assert.ok(Buffer.byteLength(result.stdout) - 1 <= READER_LIMITS.response_bytes);
  return JSON.parse(result.stdout);
}

function seedInvocation(f, { ids, request = {}, now = NOW } = {}) {
  const catalogs = f.catalog.loadRuntimeCatalogs();
  const results = {};
  for (const [layer, idKey] of Object.entries({ evidence: "evidence_id", cases: "case_id", invariants: "id", tactics: "id" })) {
    results[layer] = catalogs[layer].map((record) => record[idKey]).filter((id) => !ids || ids.includes(id));
  }
  return f.surface.logConsultation({
    taskPacket: { task_id: crypto.randomUUID(), title: "Selected-record fixture" },
    consultTrigger: "discretionary",
    request: {
      request_id: "req_reader_fixture", query: "scope filter ranking", workspace_id: "ecitr_model",
      project_scope: "project_family", intent: "analysis", ...request,
    },
    retrieval: { response: { results } },
    catalogs,
    now,
  });
}

function read(f, invocation, ids, options = {}) {
  return f.surface.readProjectMemoryRecords({ invocationId: invocation.invocation_id, recordIds: ids, now: NOW, ...options });
}

function noBody(result, reason) {
  assert.notEqual(result.result, "available");
  if (reason) assert.equal(result.reason, reason);
  assert.equal(Object.hasOwn(result, "record"), false);
  assert.equal(Object.hasOwn(result, "excerpt"), false);
}

function mutateRecord(f, type, mutate) {
  const id = type === "case" ? f.records.case.case_id : type === "evidence" ? f.records.evidence.evidence_id : f.records[type].id;
  const file = f.catalog.getRecordPath(type, id);
  const record = readJson(file);
  mutate(record);
  writeJson(file, record);
}

test("search CLI -> isolated wrapper -> usage callback delivers exact content with one preparation ledger", (t) => {
  const f = fixture(t);
  const invocation = searchCli(f);
  const caseId = f.records.case.case_id;
  const evidenceId = f.records.evidence.evidence_id;
  assert.ok(invocation.returned_record_ids.cases.includes(caseId));
  assert.ok(invocation.returned_record_ids.evidence.includes(evidenceId));
  const beforeSources = Object.fromEntries(["case", "evidence", "invariant", "tactic"].map((type) => {
    const id = type === "case" ? caseId : type === "evidence" ? evidenceId : f.records[type].id;
    const file = f.catalog.getRecordPath(type, id);
    return [file, sha256(fs.readFileSync(file))];
  }));
  const metadataOnly = success(readWrapper(f, invocation, [evidenceId]));
  assert.equal(metadataOnly.results[0].content_kind, "evidence_metadata");
  assert.equal(Object.hasOwn(metadataOnly.results[0], "excerpt"), false);
  assert.equal(Object.hasOwn(metadataOnly.results[0], "payload_hash_verified"), false);
  assert.equal(Object.hasOwn(metadataOnly.results[0], "version"), false);
  assert.equal(Object.hasOwn(metadataOnly.results[0].record, "applicability"), false);

  const excerptFlags = ["--evidence-id", evidenceId, "--start-line", "2", "--end-line", "2"];
  const response = success(readWrapper(f, invocation, [caseId, evidenceId], excerptFlags));
  const [caseResult, evidenceResult] = response.results;
  assert.deepEqual(caseResult.record, f.records.case);
  assert.deepEqual(caseResult.record.applicability.when_not_to_apply, f.records.case.applicability.when_not_to_apply);
  assert.equal(caseResult.version, 1);
  assert.equal(caseResult.basis_state, "matched");
  assert.equal(caseResult.hash_algorithm, "ecitr-structural-json-v1");
  const caseBytes = fs.readFileSync(f.catalog.getRecordPath("case", caseId));
  assert.equal(caseResult.source.sha256, sha256(caseBytes));
  assert.equal(caseResult.source.byte_start, 0);
  assert.equal(caseResult.source.byte_end, caseBytes.length);
  assert.equal(caseResult.source.end_line, caseBytes.toString("utf8").split("\n").length - 1);
  assert.equal(evidenceResult.excerpt, "שלום 💠 exact\r\n");
  const byteStart = f.payload.indexOf(Buffer.from("שלום"));
  const byteEnd = byteStart + Buffer.byteLength(evidenceResult.excerpt);
  assert.deepEqual(evidenceResult.excerpt_source, {
    catalog_ref: f.payloadRef, sha256: sha256(f.payload.subarray(byteStart, byteEnd)),
    byte_start: byteStart, byte_end: byteEnd, start_line: 2, end_line: 2, total_lines: 3,
  });
  assert.equal(evidenceResult.payload_source.sha256, sha256(f.payload));
  assert.equal(evidenceResult.payload_hash_verified, true);
  assert.equal(evidenceResult.source_hash_verified, false);
  assert.equal(evidenceResult.record.source_hash, f.records.evidence.source_hash);
  const repeated = success(readWrapper(f, invocation, [caseId, evidenceId], excerptFlags));
  assert.equal(repeated.receipt.reused, true);
  assert.equal(repeated.receipt.receipt_id, response.receipt.receipt_id);
  let artifact = readJson(invocation.artifact_path);
  assert.equal(artifact.read_receipts.length, 2);
  assert.equal(artifact.used_memory, false);
  assert.deepEqual(artifact.used_record_ids, []);
  assert.deepEqual(artifact.selected_record_ids, []);
  assert.equal(JSON.stringify(artifact.read_receipts).includes(f.records.case.action_taken), false);
  assert.equal(JSON.stringify(artifact.read_receipts).includes(evidenceResult.excerpt), false);
  const receipts = artifact.read_receipts;
  const usage = cli(f, "record-memory-usage.js", ["--invocation-id", invocation.invocation_id]);
  assert.equal(usage.status, 0, usage.stderr);
  artifact = readJson(invocation.artifact_path);
  assert.equal(artifact.used_memory, false);
  assert.deepEqual(artifact.read_receipts, receipts);
  assert.equal(fs.readdirSync(path.dirname(invocation.artifact_path)).filter((file) => file.endsWith(".json")).length, 1);
  for (const [file, hash] of Object.entries(beforeSources)) assert.equal(sha256(fs.readFileSync(file)), hash);
});

test("reader accepts planner-required evidence added to cases-only audit and verification CLI searches", (t) => {
  const f = fixture(t);
  for (const intent of ["audit", "verification"]) {
    const invocation = searchCli(f, ["--intent", intent, "--allowed-layers", "cases"]);
    const evidenceId = f.records.evidence.evidence_id;
    assert.ok(invocation.returned_record_ids.evidence.includes(evidenceId));
    assert.deepEqual(readJson(invocation.artifact_path).request.allowed_layers, ["cases"]);
    assert.equal(success(readWrapper(f, invocation, [evidenceId])).results[0].result, "available");
  }
});

test("complete tactic and invariant bodies and snapshot-specific versions are delivered without inferred fields", (t) => {
  const f = fixture(t);
  const invocation = seedInvocation(f);
  const loop = new OrchestratorExecutionLoop({ catalog: f.catalog, projectMemorySurface: f.surface });
  const response = loop.read_project_memory_records({
    invocationId: invocation.invocation_id, recordIds: [f.records.tactic.id, f.records.invariant.id], now: NOW,
  });
  assert.deepEqual(response.results[0].record, f.records.tactic);
  assert.deepEqual(response.results[0].record.rollback, f.records.tactic.rollback);
  assert.deepEqual(response.results[0].record.fallbacks, f.records.tactic.fallbacks);
  assert.deepEqual(response.results[0].record.prerequisites, f.records.tactic.prerequisites);
  assert.deepEqual(response.results[1].record, f.records.invariant);
  assert.equal(response.results[1].version, f.records.invariant.version);
});

test("structural basis uses sorted parsed values while raw file hashes identify serialization changes", (t) => {
  const f = fixture(t);
  assert.equal(structuralHash({ b: [2, 1], a: { y: null, x: false } }), structuralHash({ a: { x: false, y: null }, b: [2, 1] }));
  assert.notEqual(structuralHash({ b: [2, 1] }), structuralHash({ b: [1, 2] }));
  const invocation = seedInvocation(f);
  const id = f.records.case.case_id;
  const initial = read(f, invocation, [id]);
  const file = f.catalog.getRecordPath("case", id);
  fs.writeFileSync(file, JSON.stringify(Object.fromEntries(Object.entries(f.records.case).reverse())));
  const next = read(f, invocation, [id]);
  assert.equal(next.results[0].basis_state, "matched");
  assert.equal(next.results[0].structural_hash, initial.results[0].structural_hash);
  assert.notEqual(next.results[0].source.sha256, initial.results[0].source.sha256);
  assert.notEqual(next.receipt.receipt_id, initial.receipt.receipt_id);
});

test("legacy unpinned content remains explicit and legacy usage without a receipt remains self-reported", (t) => {
  const f = fixture(t);
  const invocation = seedInvocation(f);
  const artifact = readJson(invocation.artifact_path);
  delete artifact.retrieval_basis;
  artifact.unknown_extension = { literal: null, ordered: ["b", "a"] };
  writeJson(invocation.artifact_path, artifact);
  const response = read(f, invocation, [f.records.case.case_id]);
  assert.equal(response.results[0].result, "available");
  assert.equal(response.results[0].basis_state, "legacy_unpinned");
  assert.equal(response.results[0].retrieval_time_match, "unknown");
  assert.deepEqual(readJson(invocation.artifact_path).unknown_extension, artifact.unknown_extension);
  const legacy = seedInvocation(f);
  const usage = f.surface.recordMemoryUsage({ invocationId: legacy.invocation_id, usedRecordIds: [f.records.case.case_id] });
  assert.equal(usage.used_memory, true);
  assert.equal(Object.hasOwn(readJson(legacy.artifact_path), "read_receipts"), false);
});

test("changed identity, version or content never substitutes current content for the returned snapshot", async (t) => {
  for (const [name, mutate] of [
    ["identity", (record) => { record.case_id = "case_replacement"; }],
    ["version", (record) => { record.case_version += 1; }],
    ["content", (record) => { record.action_taken = "Different action with the original version."; }],
  ]) await t.test(name, (t) => {
    const f = fixture(t);
    const invocation = seedInvocation(f);
    mutateRecord(f, "case", mutate);
    const result = read(f, invocation, [f.records.case.case_id]).results[0];
    assert.equal(result.result, "stale");
    noBody(result);
  });
});

test("current workspace, lifecycle, approval, tactic freshness and blocked scope remain disclosure gates", async (t) => {
  const scenarios = [
    ["workspace change", "case", (record) => { record.workspace_id = "foreign_workspace"; }],
    ["missing workspace", "case", (record) => { delete record.workspace_id; }],
    ["inactive", "case", (record) => { record.status = "deprecated"; }],
    ["unapproved", "case", (record) => { record.review_state = "reviewed"; }],
    ["expired", "tactic", (record) => { record.expiry_at = "2026-01-01T00:00:00Z"; }],
    ["invalidated", "tactic", (record) => { record.invalidated_by = ["source changed"]; }],
    ["invalid schema", "case", (record) => { record.action_taken = null; }],
    ["blocked case under global request", "case", (record) => { record.context.project_scope = "blocked"; }],
    ["blocked evidence under global request", "evidence", (record) => { record.project_scope = "blocked"; }],
  ];
  for (const [name, type, mutate] of scenarios) await t.test(name, (t) => {
    const f = fixture(t);
    const invocation = seedInvocation(f, { request: { project_scope: "global" } });
    mutateRecord(f, type, mutate);
    const id = type === "case" ? f.records.case.case_id : type === "evidence" ? f.records.evidence.evidence_id : f.records.tactic.id;
    const result = read(f, invocation, [id]).results[0];
    assert.equal(result.result, "denied");
    noBody(result, name.startsWith("blocked") ? "blocked_scope" : undefined);
  });
});

test("a correction appended after search makes the selected evidence stale and malformed full graphs fail closed", async (t) => {
  for (const mode of ["correction", "missing parent", "fork", "cycle"]) await t.test(mode, (t) => {
    const f = fixture(t);
    const invocation = seedInvocation(f);
    const child = { ...f.records.evidence, evidence_id: "ev_reader_correction", correction_of: f.records.evidence.evidence_id };
    if (mode === "missing parent") child.correction_of = "ev_absent";
    writeJson(f.catalog.getRecordPath("evidence", child.evidence_id), child);
    if (mode === "fork") writeJson(f.catalog.getRecordPath("evidence", "ev_reader_fork"), { ...child, evidence_id: "ev_reader_fork" });
    if (mode === "cycle") mutateRecord(f, "evidence", (record) => { record.correction_of = child.evidence_id; });
    const results = read(f, invocation, [f.records.evidence.evidence_id, f.records.case.case_id]).results;
    noBody(results[0], mode === "correction" ? "evidence_corrected" : "invalid_correction_graph");
    if (mode === "correction") assert.equal(results[0].result, "stale");
    else noBody(results[1], "invalid_correction_graph");
  });
});

test("invalid selections and unbound invocations fail without a body or receipt mutation", async (t) => {
  const scenarios = [
    ["nonreturned", (artifact) => { artifact.returned_record_ids.cases = []; }],
    ["request null", (artifact) => { artifact.request = null; }],
    ["not consulted", (artifact) => { artifact.memory_consulted = false; }],
    ["foreign workspace", (artifact) => { artifact.workspace_id = "other"; }],
    ["missing workspace", (artifact) => { delete artifact.workspace_id; }],
    ["request workspace", (artifact) => { artifact.request.workspace_id = "other"; }],
    ["request scope", (artifact) => { artifact.request.project_scope = "invented"; }],
    ["catalog", (artifact) => { artifact.catalog_root = "/unbound/catalog"; }],
    ["unsupported layer", (artifact) => { artifact.returned_record_ids.support = ["case_any"]; }],
    ["duplicate record", (artifact) => { artifact.returned_record_ids.cases.push(artifact.returned_record_ids.cases[0]); }],
  ];
  for (const [name, mutate] of scenarios) await t.test(name, (t) => {
    const f = fixture(t);
    const invocation = seedInvocation(f);
    const artifact = readJson(invocation.artifact_path);
    mutate(artifact);
    writeJson(invocation.artifact_path, artifact);
    const before = fs.readFileSync(invocation.artifact_path);
    const result = readWrapper(f, invocation, [f.records.case.case_id]);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.deepEqual(fs.readFileSync(invocation.artifact_path), before);
  });
  await t.test("literal input and duplicate invocation paths", (t) => {
    const f = fixture(t);
    const invocation = seedInvocation(f);
    for (const ids of [["../case_escape"], [f.records.case.case_id, f.records.case.case_id], ["case_" + "x".repeat(200)], Array.from({ length: 6 }, (_, i) => `case_${i}`)]) {
      assert.throws(() => read(f, invocation, ids));
    }
    assert.throws(() => read(f, { invocation_id: "../escape" }, [f.records.case.case_id]));
    const duplicate = path.join(f.surface.artifactRoot, "2025", "01", `${invocation.invocation_id}.json`);
    writeJson(duplicate, readJson(invocation.artifact_path));
    assert.throws(() => read(f, invocation, [f.records.case.case_id]), /duplicate_invocation_matches/);
  });
});

test("marker changes cannot rebind an existing selected-record invocation", (t) => {
  const f = fixture(t);
  const invocation = seedInvocation(f);
  const marker = readJson(path.join(f.root, "ecitr.project.json"));
  marker.workspace_id = "foreign_workspace";
  writeJson(path.join(f.root, "ecitr.project.json"), marker);
  assert.throws(() => read(f, invocation, [f.records.case.case_id]), /invocation_workspace_mismatch/);
});

test("sidecar containment, hash, UTF8 and source-size failures disclose no record or excerpt", async (t) => {
  const scenarios = [
    ["traversal", (f) => mutateRecord(f, "evidence", (record) => { record.verbatim_payload_ref = "payloads/evidence/../../private.txt"; })],
    ["live locator", (f) => mutateRecord(f, "evidence", (record) => { record.verbatim_payload_ref = "https://example.invalid/private"; })],
    ["missing", (f) => fs.unlinkSync(path.join(f.catalogRoot, f.payloadRef))],
    ["hash mismatch", (f) => fs.writeFileSync(path.join(f.catalogRoot, f.payloadRef), "different payload\n")],
    ["invalid UTF8", (f) => fs.writeFileSync(path.join(f.catalogRoot, f.payloadRef), Buffer.from([0xff, 10]))],
    ["oversized payload", (f) => fs.writeFileSync(path.join(f.catalogRoot, f.payloadRef), Buffer.alloc(READER_LIMITS.source_bytes + 1, 65))],
    ["symlink escape", (f) => {
      const outside = path.join(f.root, "outside.txt");
      fs.writeFileSync(outside, f.payload);
      fs.unlinkSync(path.join(f.catalogRoot, f.payloadRef));
      fs.symlinkSync(outside, path.join(f.catalogRoot, f.payloadRef));
    }],
  ];
  for (const [name, mutate] of scenarios) await t.test(name, (t) => {
    const f = fixture(t);
    mutate(f);
    const invocation = seedInvocation(f);
    const id = f.records.evidence.evidence_id;
    const result = read(f, invocation, [id], { evidenceExcerpt: { recordId: id, startLine: 1, endLine: 1 } }).results[0];
    noBody(result, name === "oversized payload" ? "input_budget_exceeded" : undefined);
  });
});

test("canonical symlink escapes and oversized or malformed source snapshots fail before disclosure", async (t) => {
  for (const mode of ["symlink", "oversized", "UTF8"]) await t.test(mode, (t) => {
    const f = fixture(t);
    const invocation = seedInvocation(f);
    const file = f.catalog.getRecordPath("case", f.records.case.case_id);
    if (mode === "symlink") {
      const outside = path.join(f.root, "outside.json");
      fs.copyFileSync(file, outside);
      fs.unlinkSync(file);
      fs.symlinkSync(outside, file);
    } else fs.writeFileSync(file, mode === "oversized" ? Buffer.alloc(READER_LIMITS.source_bytes + 1, 65) : Buffer.from([0xff]));
    noBody(read(f, invocation, [f.records.case.case_id]).results[0], mode === "oversized" ? "input_budget_exceeded" : undefined);
  });
});

test("canonical and payload FIFOs are rejected without blocking on open", async (t) => {
  for (const type of ["case", "evidence"]) await t.test(type, (t) => {
    const f = fixture(t);
    const invocation = seedInvocation(f);
    const id = type === "case" ? f.records.case.case_id : f.records.evidence.evidence_id;
    const file = type === "case" ? f.catalog.getRecordPath("case", id) : path.join(f.catalogRoot, f.payloadRef);
    fs.unlinkSync(file);
    const pipe = spawnSync("mkfifo", [file], { encoding: "utf8" });
    assert.equal(pipe.status, 0, pipe.stderr);
    const extra = type === "case" ? [] : ["--evidence-id", id, "--start-line", "1", "--end-line", "1"];
    const result = spawnSync(WRAPPER, readerArgs(invocation, [id], extra), {
      cwd: f.root, env: f.env, encoding: "utf8", timeout: 5000,
    });
    noBody(success(result).results[0], "source_not_regular_file");
  });
});

test("excerpt bounds preserve LF ownership, CRLF, a final unterminated line, and empty-file missingness", async (t) => {
  for (const [name, bytes, startLine, endLine, expected] of [
    ["terminal LF", Buffer.from("a\r\nb\n"), 2, 2, "b\n"],
    ["unterminated", Buffer.from("א\r\n💠"), 2, 2, "💠"],
    ["empty", Buffer.alloc(0), 1, 1, null],
    ["past final LF", Buffer.from("a\n"), 2, 2, null],
    ["byte budget", Buffer.alloc(8193, 65), 1, 1, null],
  ]) await t.test(name, (t) => {
    const f = fixture(t);
    fs.writeFileSync(path.join(f.catalogRoot, f.payloadRef), bytes);
    mutateRecord(f, "evidence", (record) => { record.payload_hash = sha256(bytes); });
    const invocation = seedInvocation(f);
    const id = f.records.evidence.evidence_id;
    const result = read(f, invocation, [id], { evidenceExcerpt: { recordId: id, startLine, endLine } }).results[0];
    if (expected === null) noBody(result, name === "byte budget" ? "excerpt_byte_budget_exceeded" : "excerpt_out_of_range");
    else {
      assert.equal(result.excerpt, expected);
      assert.equal(result.excerpt_source.sha256, sha256(Buffer.from(expected)));
      assert.deepEqual(bytes.subarray(result.excerpt_source.byte_start, result.excerpt_source.byte_end), Buffer.from(expected));
    }
    for (const span of [{ startLine: 0, endLine: 1 }, { startLine: 2, endLine: 1 }, { startLine: 1, endLine: 81 }]) {
      assert.throws(() => read(f, invocation, [id], { evidenceExcerpt: { recordId: id, ...span } }));
    }
  });
});

test("complete compact response reserves every result's metadata before accepting any body", (t) => {
  const f = fixture(t);
  const ids = [f.records.case.case_id];
  for (let i = 1; i < 5; i += 1) {
    const record = { ...f.records.case, case_id: `case_budget_${i}` };
    f.catalog.writeRecord("case", record);
    ids.push(record.case_id);
  }
  const smallInvocation = seedInvocation(f, { ids });
  const small = read(f, smallInvocation, [ids[0]]);
  const growth = READER_LIMITS.response_bytes - Buffer.byteLength(JSON.stringify(small)) - 256;
  mutateRecord(f, "case", (record) => { record.action_taken += "A".repeat(growth); });
  const invocation = seedInvocation(f, { ids });
  const one = read(f, invocation, [ids[0]]);
  assert.equal(one.results[0].result, "available");
  const combined = read(f, invocation, ids);
  assert.deepEqual(combined.results.map((result) => result.record_id), ids);
  noBody(combined.results[0], "budget_exceeded");
  assert.ok(combined.results.slice(1).every((result) => result.result === "available"));
  assert.ok(Buffer.byteLength(JSON.stringify(combined)) <= READER_LIMITS.response_bytes);
  for (const result of combined.results.filter((entry) => entry.result === "available")) {
    assert.deepEqual(result.record, f.catalog.getRecord("case", result.record_id));
  }
});

test("twenty distinct receipts are retained, identical reads reuse at the cap, and usage remains writable", (t) => {
  const f = fixture(t);
  const invocation = seedInvocation(f);
  const id = f.records.case.case_id;
  const file = f.catalog.getRecordPath("case", id);
  const body = JSON.stringify(f.records.case);
  let response;
  for (let i = 1; i <= 20; i += 1) {
    fs.writeFileSync(file, body + "\n".repeat(i));
    response = read(f, invocation, [id]);
    assert.equal(response.receipt.reused, false);
  }
  assert.equal(read(f, invocation, [id]).receipt.receipt_id, response.receipt.receipt_id);
  assert.equal(read(f, invocation, [id]).receipt.reused, true);
  const priorBytes = fs.readFileSync(invocation.artifact_path);
  fs.writeFileSync(file, body + "\n".repeat(21));
  assert.throws(() => read(f, invocation, [id]), /read_receipt_cap_reached/);
  assert.deepEqual(fs.readFileSync(invocation.artifact_path), priorBytes);
  const receiptHistory = readJson(invocation.artifact_path).read_receipts;
  assert.equal(receiptHistory.length, 20);
  assert.equal(f.surface.recordMemoryUsage({ invocationId: invocation.invocation_id, usedRecordIds: [id] }).used_memory, true);
  assert.deepEqual(readJson(invocation.artifact_path).read_receipts, receiptHistory);
});

function child(command, args, f, extraEnv = {}) {
  const proc = spawn(command, args, { cwd: f.root, env: { ...f.env, ...extraEnv }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  proc.stdout.on("data", (data) => { stdout += data; });
  proc.stderr.on("data", (data) => { stderr += data; });
  return new Promise((resolve, reject) => {
    proc.on("error", reject);
    proc.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

test("competing reader and callback processes preserve both receipts, usage and unknown artifact fields", async (t) => {
  const f = fixture(t);
  const invocation = seedInvocation(f);
  const artifact = readJson(invocation.artifact_path);
  artifact.unknown_extension = { literal: null, list: ["z", "a"] };
  writeJson(invocation.artifact_path, artifact);
  const lockPath = `${invocation.artifact_path}.lock`;
  const lock = fs.openSync(lockPath, "wx");
  const caseId = f.records.case.case_id;
  const pending = [
    child(WRAPPER, readerArgs(invocation, [caseId]), f),
    child(WRAPPER, readerArgs(invocation, [f.records.evidence.evidence_id]), f),
    child(process.execPath, [path.join(REPO_ROOT, "src/cli/record-memory-usage.js"), "--invocation-id", invocation.invocation_id, "--used-record-ids", caseId], f),
  ];
  await new Promise((resolve) => setTimeout(resolve, 350));
  fs.closeSync(lock);
  fs.unlinkSync(lockPath);
  const results = await Promise.all(pending);
  for (const result of results) assert.equal(result.status, 0, result.stderr);
  const after = readJson(invocation.artifact_path);
  assert.equal(after.read_receipts.length, 2);
  assert.equal(after.used_memory, true);
  assert.deepEqual(after.used_returned_record_ids, [caseId]);
  assert.deepEqual(after.unknown_extension, artifact.unknown_extension);
  assert.equal(fs.existsSync(lockPath), false);
});

test("contention never steals an old lock and a failed atomic replacement emits no body or receipt success", (t) => {
  const f = fixture(t);
  const invocation = seedInvocation(f);
  const id = f.records.case.case_id;
  const prior = fs.readFileSync(invocation.artifact_path);
  const lockPath = `${invocation.artifact_path}.lock`;
  const lock = fs.openSync(lockPath, "wx");
  fs.utimesSync(lockPath, new Date(0), new Date(0));
  const contended = readWrapper(f, invocation, [id]);
  assert.equal(contended.status, 1);
  assert.equal(contended.stdout, "");
  assert.equal(JSON.parse(contended.stderr).error, "invocation_update_contended");
  assert.equal(fs.lstatSync(lockPath).ino, fs.fstatSync(lock).ino);
  assert.deepEqual(fs.readFileSync(invocation.artifact_path), prior);
  fs.closeSync(lock);
  fs.unlinkSync(lockPath);

  const preload = path.join(f.root, "fail-rename.cjs");
  fs.writeFileSync(preload, `const fs = require('node:fs');\nconst rename = fs.renameSync;\nfs.renameSync = function(from, to) { if (to === ${JSON.stringify(invocation.artifact_path)}) { const error = new Error('fixture persistence failure'); error.code = 'EIO'; throw error; } return rename.apply(this, arguments); };\n`);
  const failed = readWrapper(f, invocation, [id], [], { NODE_OPTIONS: `--require ${JSON.stringify(preload)}` });
  assert.equal(failed.status, 1);
  assert.equal(failed.stdout, "");
  assert.equal(JSON.parse(failed.stderr).error, "invocation_persistence_failed");
  assert.deepEqual(fs.readFileSync(invocation.artifact_path), prior);
  assert.equal(fs.existsSync(lockPath), false);
  assert.deepEqual(fs.readdirSync(path.dirname(invocation.artifact_path)), [path.basename(invocation.artifact_path)]);
});

test("a post-lstat invocation swap cannot import outside returned IDs or block on a FIFO", async (t) => {
  for (const kind of ["symlink", "fifo"]) await t.test(kind, (t) => {
    const f = fixture(t);
    const invocation = seedInvocation(f, { ids: [] });
    const id = f.records.case.case_id;
    const original = fs.readFileSync(invocation.artifact_path);
    const outside = path.join(f.root, "outside-invocation.json");
    const backup = path.join(f.root, "original-invocation.json");
    const forged = readJson(invocation.artifact_path);
    forged.returned_record_ids.cases = [id];
    delete forged.retrieval_basis;
    writeJson(outside, forged);
    const outsideBytes = fs.readFileSync(outside);
    const preload = path.join(f.root, "swap-invocation.cjs");
    fs.writeFileSync(preload, `const fs = require('node:fs');
const target = ${JSON.stringify(invocation.artifact_path)};
const lstat = fs.lstatSync;
let swapped = false;
fs.lstatSync = function(file) {
  const stat = lstat.apply(this, arguments);
  if (file === target && !swapped) {
    swapped = true;
    fs.renameSync(target, ${JSON.stringify(backup)});
    ${kind === "symlink" ? `fs.symlinkSync(${JSON.stringify(outside)}, target);` : "require('node:child_process').execFileSync('mkfifo', [target]);"}
  }
  return stat;
};
`);
    const result = spawnSync(WRAPPER, readerArgs(invocation, [id]), {
      cwd: f.root, env: { ...f.env, NODE_OPTIONS: `--require ${JSON.stringify(preload)}` },
      encoding: "utf8", timeout: 5000,
    });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, "");
    assert.equal(JSON.parse(result.stderr).error, "invocation_changed_during_update");
    assert.deepEqual(fs.readFileSync(backup), original);
    assert.deepEqual(fs.readFileSync(outside), outsideBytes);
    assert.equal(Object.hasOwn(readJson(backup), "read_receipts"), false);
    assert.equal(Object.hasOwn(readJson(outside), "read_receipts"), false);
    assert.equal(fs.lstatSync(invocation.artifact_path)[kind === "symlink" ? "isSymbolicLink" : "isFIFO"](), true);
    assert.equal(fs.existsSync(`${invocation.artifact_path}.lock`), false);
  });
});

test("publication rejects replacement identity and in-place byte drift after preparing the temporary artifact", async (t) => {
  for (const kind of ["replacement", "in_place"]) await t.test(kind, (t) => {
    const f = fixture(t);
    const invocation = seedInvocation(f);
    const original = fs.readFileSync(invocation.artifact_path);
    const originalInode = fs.statSync(invocation.artifact_path).ino;
    const outside = path.join(f.root, "outside-invocation.json");
    const backup = path.join(f.root, "original-invocation.json");
    const changed = readJson(invocation.artifact_path);
    changed.returned_record_ids.cases = [];
    fs.writeFileSync(outside, kind === "replacement" ? original : Buffer.from(JSON.stringify(changed)));
    const outsideBytes = fs.readFileSync(outside);
    const preload = path.join(f.root, "change-before-publish.cjs");
    fs.writeFileSync(preload, `const fs = require('node:fs');
const target = ${JSON.stringify(invocation.artifact_path)};
const outside = ${JSON.stringify(outside)};
const fsync = fs.fsyncSync;
let changed = false;
fs.fsyncSync = function() {
  const result = fsync.apply(this, arguments);
  if (!changed) {
    changed = true;
    fs.${kind === "replacement" ? "renameSync" : "copyFileSync"}(target, ${JSON.stringify(backup)});
    fs.writeFileSync(target, fs.readFileSync(outside));
  }
  return result;
};
`);
    const result = readWrapper(f, invocation, [f.records.case.case_id], [], { NODE_OPTIONS: `--require ${JSON.stringify(preload)}` });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, "");
    assert.equal(JSON.parse(result.stderr).error, "invocation_changed_during_update");
    assert.deepEqual(fs.readFileSync(backup), original);
    assert.deepEqual(fs.readFileSync(outside), outsideBytes);
    assert.deepEqual(fs.readFileSync(invocation.artifact_path), outsideBytes);
    assert.equal(fs.statSync(invocation.artifact_path).ino === originalInode, kind === "in_place");
    assert.equal(Object.hasOwn(readJson(invocation.artifact_path), "read_receipts"), false);
    assert.deepEqual(fs.readdirSync(path.dirname(invocation.artifact_path)), [path.basename(invocation.artifact_path)]);
  });
});

test("reader and legacy callback reject malformed invocation UTF-8 without replacing unknown bytes", (t) => {
  const f = fixture(t);
  const invocation = seedInvocation(f);
  const artifact = readJson(invocation.artifact_path);
  const bytes = Buffer.concat([
    Buffer.from(`${JSON.stringify(artifact).slice(0, -1)},"unknown_extension":"`),
    Buffer.from([0xff]), Buffer.from('"}\n'),
  ]);
  fs.writeFileSync(invocation.artifact_path, bytes);
  const reader = readWrapper(f, invocation, [f.records.case.case_id]);
  const callback = cli(f, "record-memory-usage.js", ["--invocation-id", invocation.invocation_id]);
  for (const result of [reader, callback]) {
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(JSON.parse(result.stderr).error, "invalid_invocation_utf8");
  }
  assert.deepEqual(fs.readFileSync(invocation.artifact_path), bytes);
  assert.equal(fs.existsSync(`${invocation.artifact_path}.lock`), false);
});

test("the invocation input cap also rejects legacy usage updates without altering the existing artifact", (t) => {
  const f = fixture(t);
  const invocation = seedInvocation(f);
  const artifact = readJson(invocation.artifact_path);
  artifact.legacy_extension = "x".repeat(4 * 1024 * 1024);
  writeJson(invocation.artifact_path, artifact);
  const before = fs.readFileSync(invocation.artifact_path);
  const reader = readWrapper(f, invocation, [f.records.case.case_id]);
  const callback = cli(f, "record-memory-usage.js", ["--invocation-id", invocation.invocation_id]);
  for (const result of [reader, callback]) {
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
  }
  assert.deepEqual(fs.readFileSync(invocation.artifact_path), before);
  assert.equal(fs.existsSync(`${invocation.artifact_path}.lock`), false);
});
