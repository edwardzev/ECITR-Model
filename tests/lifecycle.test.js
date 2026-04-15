const test = require("node:test");
const assert = require("node:assert/strict");

const {
  canTransition,
  assertTransition,
  assertLifecycleRecord,
  assertCaseRevision,
  assertSupersessionPair,
} = require("../src/lifecycle/rules");
const { loadExample } = require("./helpers/load-example");

test("case lifecycle allows draft to active and blocks active to draft", () => {
  assert.equal(canTransition("case", "draft", "active"), true);
  assert.equal(canTransition("case", "active", "draft"), false);
  assert.throws(() => assertTransition("case", "active", "draft"));
});

test("evidence lifecycle enforces immutability", () => {
  const evidence = loadExample("evidence");
  evidence.immutable = false;

  assert.throws(() => assertLifecycleRecord("evidence", evidence));
});

test("case revision must keep series identity and increment version", () => {
  const previous = loadExample("case");
  const next = structuredClone(previous);
  next.case_version = previous.case_version + 1;

  assert.doesNotThrow(() => assertCaseRevision(previous, next));

  next.case_version = previous.case_version;
  assert.throws(() => assertCaseRevision(previous, next));
});

test("invariant supersession pair must remain in the same series and point both ways", () => {
  const older = loadExample("invariant");
  const newer = structuredClone(older);

  older.status = "superseded";
  older.superseded_by = "inv_scope_filter_before_rank_002";

  newer.id = "inv_scope_filter_before_rank_002";
  newer.version = 2;
  newer.supersedes = older.id;
  delete newer.superseded_by;

  assert.doesNotThrow(() => assertSupersessionPair("invariant", older, newer));

  newer.series_key = "wrong-series";
  assert.throws(() => assertSupersessionPair("invariant", older, newer));
});
