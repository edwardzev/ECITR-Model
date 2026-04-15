const test = require("node:test");
const assert = require("node:assert/strict");

const { evaluateTacticFreshness } = require("../src/tactics/freshness");
const { loadExample } = require("./helpers/load-example");

test("fresh tactic is usable", () => {
  const tactic = loadExample("tactic");
  const result = evaluateTacticFreshness(tactic, { now: new Date("2026-05-01T00:00:00Z") });

  assert.equal(result.status, "fresh");
  assert.equal(result.usable, true);
});

test("expired tactic is unusable", () => {
  const tactic = loadExample("tactic");
  tactic.expiry_at = "2020-01-01T00:00:00Z";
  delete tactic.revalidate_at;

  const result = evaluateTacticFreshness(tactic, { now: new Date("2026-05-01T00:00:00Z") });

  assert.equal(result.status, "expired");
  assert.equal(result.usable, false);
});

test("invalidated tactic is unusable", () => {
  const tactic = loadExample("tactic");
  tactic.invalidated_by = ["regression_001"];

  const result = evaluateTacticFreshness(tactic);

  assert.equal(result.status, "invalidated");
  assert.equal(result.usable, false);
});
