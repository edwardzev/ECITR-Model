const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { evaluateRetrievalEligibility } = require("../src/retrieval/eligibility");
const { RetrievalRuntime } = require("../src/retrieval/runtime");
const { RuntimeInterventionRunner } = require("../src/runtime/intervention-runner");
const { FileBackedCatalog } = require("../src/storage/file-backed-catalog");
const { refreshSupportGraph } = require("../src/support-graph/refresh");
const { EcitrValidator } = require("../src/validation/validator");
const { loadExample } = require("./helpers/load-example");

const NOW = new Date("2026-05-01T00:00:00Z");
const validator = new EcitrValidator();
const SCOPES = ["project", "project_family", "global"];
const ELIGIBILITY_BY_RECORD_SCOPE = {
  project: [true, false, true],
  project_family: [false, true, true],
  global: [true, true, true],
  blocked: [false, false, false],
};

function makeRequest(projectScope = "global") {
  return {
    request_id: "req_blocked_scope_regression",
    query: "scope filter ranking project retrieval",
    workspace_id: "ecitr_model",
    project_scope: projectScope,
    intent: "analysis",
    allowed_layers: ["cases", "evidence"],
    max_results_per_layer: { cases: 1, evidence: 1 },
  };
}

function setScope(layer, record, scope) {
  if (layer === "cases") record.context.project_scope = scope;
  else record.project_scope = scope;
  return record;
}

for (const [layer, recordType] of [["cases", "case"], ["evidence", "evidence"]]) {
  for (const [recordScope, expected] of Object.entries(ELIGIBILITY_BY_RECORD_SCOPE)) {
    for (const [index, requestScope] of SCOPES.entries()) {
      test(`${layer} scope ${recordScope} under ${requestScope} preserves the eligibility contract`, () => {
        const record = setScope(layer, loadExample(recordType), recordScope);
        const request = makeRequest(requestScope);
        validator.validateRecord(recordType, record);
        validator.validateRecord("retrieval_request", request);
        const result = evaluateRetrievalEligibility({ layer, record, request, now: NOW });
        assert.equal(result.eligible, expected[index]);
        assert.equal(result.exclude, !expected[index]);
        assert.equal(result.code, expected[index] ? null : "scope_conflict");
      });
    }
  }

  test(`${layer} workspace rejection keeps precedence over blocked scope`, () => {
    const record = setScope(layer, loadExample(recordType), "blocked");
    record.workspace_id = "different_workspace";
    const result = evaluateRetrievalEligibility({ layer, record, request: makeRequest(), now: NOW });
    assert.equal(result.code, "workspace_conflict");
    assert.equal(result.exclude, true);
  });
}

for (const [status, reviewState, expectedCode] of [
  ["draft", "draft", "inactive_status"],
  ["active", "draft", "case_not_approved"],
]) {
  test(`blocked case retains ${expectedCode} precedence`, () => {
    const record = setScope("cases", loadExample("case"), "blocked");
    record.status = status;
    record.review_state = reviewState;
    const result = evaluateRetrievalEligibility({ layer: "cases", record, request: makeRequest(), now: NOW });
    assert.equal(result.code, expectedCode);
    assert.equal(result.exclude, true);
  });
}

function makeCatalogs() {
  const blockedCase = setScope("cases", loadExample("case"), "blocked");
  const blockedEvidence = setScope("evidence", loadExample("evidence"), "blocked");
  const allowedCase = setScope("cases", loadExample("case"), "global");
  const allowedEvidence = setScope("evidence", loadExample("evidence"), "global");
  allowedCase.case_id = "case_zzz_allowed_scope_control";
  allowedEvidence.evidence_id = "ev_zzz_allowed_scope_control";
  allowedEvidence.source_locator += "?allowed-control";
  return {
    cases: [blockedCase, allowedCase],
    evidence: [blockedEvidence, allowedEvidence],
    tactics: [],
    invariants: [],
    atomic_claim_sets: [],
    parameter_definitions: [],
    parameter_observations: [],
    review_audit_entries: [],
  };
}

for (const requestScope of SCOPES) {
  test(`runtime ${requestScope} retrieval keeps eligible controls in one-slot budgets`, async () => {
    const catalogs = makeCatalogs();
    const before = structuredClone(catalogs);
    const runtime = new RetrievalRuntime({ responseEnricher: null });
    const { response, diagnostics } = await runtime.execute({
      request: makeRequest(requestScope), catalogs, now: NOW,
    });
    assert.deepEqual(response.results, {
      tactics: [], invariants: [],
      cases: ["case_zzz_allowed_scope_control"],
      evidence: ["ev_zzz_allowed_scope_control"],
    });
    assert.equal(diagnostics.fusion.excluded_by_code.scope_conflict, 2);
    assert.deepEqual(catalogs, before);
  });
}

test("runtime abstains when global retrieval has only blocked records", async () => {
  const catalogs = makeCatalogs();
  catalogs.cases.pop();
  catalogs.evidence.pop();
  const { response } = await new RetrievalRuntime({ responseEnricher: null }).execute({
    request: makeRequest(), catalogs, now: NOW,
  });
  assert.deepEqual(response.results, { tactics: [], invariants: [], cases: [], evidence: [] });
  assert.ok(response.explanations.some((message) => message.includes("retrieval abstained")));
});

test("global intervention graph expansion excludes blocked neighbors and keeps eligible controls", async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-blocked-scope-graph-"));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const catalogs = makeCatalogs();
  const seed = setScope("evidence", loadExample("evidence"), "global");
  seed.evidence_id = "ev_scope_graph_seed";
  seed.source_locator = "https://fixtures.invalid/only_seed_locator_37264";
  catalogs.cases[0].evidence_refs = [seed.evidence_id, catalogs.evidence[0].evidence_id];
  catalogs.cases[1].evidence_refs = [seed.evidence_id, catalogs.evidence[1].evidence_id];
  catalogs.evidence.push(seed);
  const catalog = new FileBackedCatalog({ rootDir });
  for (const record of catalogs.evidence) catalog.writeRecord("evidence", record);
  for (const record of catalogs.cases) catalog.writeRecord("case", record);
  const graphRoot = path.join(rootDir, ".local", "support-graph");
  refreshSupportGraph({ catalogRoot: rootDir, graphRoot, builtAt: NOW.toISOString() });
  const result = await new RuntimeInterventionRunner({
    graphRoot, artifactRoot: path.join(rootDir, ".local", "runtime-interventions"),
  }).run({
    intervention: {
      mode: "preflight", query: "only_seed_locator_37264",
      workspace_id: "ecitr_model", project_scope: "global",
    },
    catalogs: catalog.loadRuntimeCatalogs(), now: NOW,
  });
  assert.equal(result.intervention.weak_hit, true);
  assert.deepEqual(result.intervention.selected_results.evidence, [seed.evidence_id]);
  assert.equal(result.intervention.summary.at(-1), "weak direct hit triggered support-graph expansion");
  assert.deepEqual(result.intervention.related_candidates, {
    tactics: [], invariants: [],
    cases: ["case_zzz_allowed_scope_control"],
    evidence: ["ev_zzz_allowed_scope_control"],
  });
});
