const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { CodexImportState } = require("../src/importers/codex-import-state");

test("v1 ledger migration preserves unselected entries and unknown historical metadata", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-codex-state-"));
  const unrelated = { fingerprint: "1:2", exact_history: { field: ["retain", null, "  "] } };
  const state = new CodexImportState({ rootDir, state: {
    version: 1, historical_top_level: "preserve", sources: { "/synthetic/old.jsonl": unrelated },
  } });
  state.setSourceFingerprint("/synthetic/new.jsonl", "3:4", { parser_version: "test", coverage_status: "unsupported" });
  state.save();
  const readback = CodexImportState.load({ rootDir });
  assert.deepEqual(readback.getSourceEntry("/synthetic/old.jsonl"), unrelated);
  assert.equal(readback.getSourceFingerprint("/synthetic/new.jsonl"), "3:4");
  assert.equal(readback.state.version, 2);
  assert.equal(readback.state.historical_top_level, "preserve");
});

test("unknown ledger versions and malformed unrelated entries fail closed without changing bytes", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-codex-invalid-state-"));
  const statePath = path.join(rootDir, "state", "codex-rollouts.json");
  fs.mkdirSync(path.dirname(statePath));
  for (const invalid of [
    { version: 99, sources: {} },
    { version: 1, sources: { "/synthetic/old.jsonl": { fingerprint: null } } },
    { version: 2, sources: { "relative.jsonl": { fingerprint: "1:2" } } },
  ]) {
    const bytes = JSON.stringify(invalid);
    fs.writeFileSync(statePath, bytes);
    assert.throws(() => CodexImportState.load({ rootDir }), /Codex import state/);
    assert.equal(fs.readFileSync(statePath, "utf8"), bytes);
  }
  fs.writeFileSync(statePath, '{"PRIVATE CONTENT":');
  assert.throws(() => CodexImportState.load({ rootDir }), (error) => !error.message.includes("PRIVATE CONTENT"));
});

test("ledger publication preserves the original on concurrent drift or rename failure", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-codex-state-publish-"));
  const first = new CodexImportState({ rootDir });
  first.setSourceFingerprint("/synthetic/old.jsonl", "1:2");
  first.save();
  const stale = CodexImportState.load({ rootDir });
  first.setSourceFingerprint("/synthetic/concurrent.jsonl", "3:4");
  first.save();
  const concurrentBytes = fs.readFileSync(first.filePath);
  assert.throws(() => stale.save(), /changed after it was loaded/);
  assert.deepEqual(fs.readFileSync(first.filePath), concurrentBytes);
  const fresh = CodexImportState.load({ rootDir });
  const originalRename = fs.renameSync;
  fs.renameSync = () => { throw new Error("Synthetic rename failure"); };
  try {
    assert.throws(() => fresh.save(), /Synthetic rename failure/);
    assert.deepEqual(fs.readFileSync(first.filePath), concurrentBytes);
  } finally {
    fs.renameSync = originalRename;
  }
  assert.deepEqual(fs.readdirSync(path.dirname(first.filePath)), ["codex-rollouts.json"]);
});
