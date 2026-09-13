const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { refreshCodexIndex, runStructuralCheck } = require("../src/importers/codex-refresh");
const { parseArgs, readSourceManifest } = require("../src/cli/refresh-codex");

test("codex refresh imports before structural validation", async () => {
  const calls = [];
  const catalogs = {
    tactics: [],
    invariants: [],
    cases: [],
    evidence: [{ evidence_id: "ev_codex_thread_001", source_locator: "codex-thread://thread_001" }],
    atomic_claim_sets: [],
    review_audit_entries: [],
  };

  const summary = await refreshCodexIndex({
    codexRoot: "/tmp/.codex",
    catalogRoot: "/tmp/catalog",
    importRollouts(options) {
      calls.push({ step: "rollouts", dryRun: options.dryRun });
      return {
        errors: 0,
        conflicts: 0,
        candidate_rollouts: 3,
        eligible_rollouts: 3,
        imported: 1,
        skipped_existing: 1,
        skipped_unchanged: 1,
        skipped_checkpoint: 0,
        skipped_duplicate_source: 0,
        skipped_no_visible_messages: 0,
      };
    },
    loadCatalogs() {
      calls.push({ step: "loadCatalogs" });
      return catalogs;
    },
    structuralCheck({ importSummary }) {
      calls.push({ step: "structural" });
      return runStructuralCheck({ importSummary, catalogs });
    },
  });

  assert.deepEqual(calls, [
    { step: "rollouts", dryRun: false },
    { step: "loadCatalogs" },
    { step: "structural" },
  ]);
  assert.equal(summary.structural_checks.failed, 0);
});

test("codex refresh dry-run skips structural validation", async () => {
  const calls = [];

  const summary = await refreshCodexIndex({
    codexRoot: "/tmp/.codex",
    catalogRoot: "/tmp/catalog",
    dryRun: true,
    importRollouts(options) {
      calls.push({ step: "rollouts", dryRun: options.dryRun });
      return {
        errors: 0,
        conflicts: 0,
        candidate_rollouts: 2,
        eligible_rollouts: 2,
        planned: 2,
        skipped_unchanged: 0,
        skipped_checkpoint: 0,
      };
    },
  });

  assert.deepEqual(calls, [{ step: "rollouts", dryRun: true }]);
  assert.equal(summary.structural_checks.status, "skipped_dry_run");
});

test("codex refresh runs structural validation without an external semantic service", async () => {
  const calls = [];
  const catalogs = {
    tactics: [],
    invariants: [],
    cases: [],
    evidence: [{ evidence_id: "ev_codex_thread_001", source_locator: "codex-thread://thread_001" }],
    atomic_claim_sets: [],
    parameter_definitions: [],
    parameter_observations: [],
    review_audit_entries: [],
  };

  const summary = await refreshCodexIndex({
    codexRoot: "/tmp/.codex",
    catalogRoot: "/tmp/catalog",
    importRollouts() {
      calls.push({ step: "rollouts" });
      return {
        errors: 0,
        conflicts: 0,
        candidate_rollouts: 1,
        eligible_rollouts: 1,
        imported: 1,
        skipped_existing: 0,
        skipped_unchanged: 0,
        skipped_checkpoint: 0,
        skipped_duplicate_source: 0,
        skipped_no_visible_messages: 0,
      };
    },
    loadCatalogs() {
      calls.push({ step: "loadCatalogs" });
      return catalogs;
    },
    structuralCheck({ importSummary }) {
      calls.push({ step: "structural" });
      return runStructuralCheck({ importSummary, catalogs });
    },
  });

  assert.deepEqual(calls, [
    { step: "rollouts" },
    { step: "loadCatalogs" },
    { step: "structural" },
  ]);
  assert.equal(summary.structural_checks.failed, 0);
});

test("codex refresh fails fast when rollout import reports conflicts", async () => {
  await assert.rejects(
    () =>
      refreshCodexIndex({
        codexRoot: "/tmp/.codex",
        catalogRoot: "/tmp/catalog",
        importRollouts() {
          return { errors: 0, conflicts: 1 };
        },
      }),
    /codex rollout refresh reported conflicts or errors/,
  );
});

test("capture coverage is independent of structural and process success, including cached gaps", async () => {
  const coverage = { status: "partial", candidate_rollouts: 2, accounted_rollouts: 2, gap_count: 2,
    cached_sources: 2, source_statuses: { unsupported: 1, unknown: 1 } };
  const summary = await refreshCodexIndex({
    codexRoot: "/tmp/.codex", catalogRoot: "/tmp/catalog",
    importRollouts: () => ({ errors: 0, conflicts: 0, candidate_rollouts: 2, eligible_rollouts: 0, skipped_unchanged: 2, coverage }),
    loadCatalogs: () => ({ evidence: [] }),
  });
  assert.equal(summary.structural_checks.failed, 0);
  assert.deepEqual(summary.coverage, coverage);
});

test("structural accounting includes planned, rejected, repair-required and failed candidates", () => {
  const summary = { candidate_rollouts: 9, planned: 1, rejected_unsupported: 1, rejected_partial: 1,
    rejected_malformed: 1, repair_required: 1, not_attempted: 1, errors: 1, conflicts: 1, skipped_workspace_filter: 1 };
  const checked = runStructuralCheck({ importSummary: summary, catalogs: { evidence: [] } });
  assert.equal(checked.failed, 0);
  assert.equal(checked.checks[0].detail.accounted_rollouts, 9);
});

test("refresh forwards exact source selection and reports a blocked preflight", async () => {
  const sourceSelection = [{ path: "/tmp/.codex/sessions/exact.jsonl", sha256: `sha256:${"a".repeat(64)}`, threadId: "exact" }];
  await assert.rejects(() => refreshCodexIndex({
    codexRoot: "/tmp/.codex", catalogRoot: "/tmp/catalog", sourceSelection,
    importRollouts(options) {
      assert.deepEqual(options.sourceSelection, sourceSelection);
      return { errors: 0, conflicts: 0, preflight: { status: "blocked" }, coverage: { status: "partial" } };
    },
  }), (error) => error.summary.preflight.status === "blocked");
});

test("source manifest CLI preserves exact source pins and rejects malformed manifest text without quoting it", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-codex-manifest-"));
  const manifestPath = path.join(root, "sources.json");
  const source = { path: "/synthetic/sessions/exact.jsonl", sha256: `sha256:${"a".repeat(64)}`, thread_id: "exact" };
  fs.writeFileSync(manifestPath, JSON.stringify({ version: 1, sources: [source] }));
  const options = parseArgs(["--source-manifest", manifestPath, "--dry-run"]);
  assert.deepEqual(options.sourceSelection, [{ path: source.path, sha256: source.sha256, threadId: source.thread_id }]);
  assert.equal(options.dryRun, true);
  fs.writeFileSync(manifestPath, '{"PRIVATE MANIFEST":');
  assert.throws(() => readSourceManifest(manifestPath), (error) => !error.message.includes("PRIVATE MANIFEST"));
});
