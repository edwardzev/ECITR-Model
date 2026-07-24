const test = require("node:test");
const assert = require("node:assert/strict");

const { InvariantPromotionPipeline } = require("../src/invariants/promotion");
const { loadExample } = require("./helpers/load-example");

test("invariant promotion compiles a draft invariant from a staging packet", () => {
  const pipeline = new InvariantPromotionPipeline();
  const packet = loadExample("invariant_promotion_packet");

  const draft = pipeline.compileDraft(packet);

  assert.equal(draft.status, "draft");
  assert.equal(draft.id, packet.proposed_invariant_id);
  assert.equal(draft.workspace_id, "ecitr_model");
});

test("multi-case promotion requires at least two source cases", () => {
  const pipeline = new InvariantPromotionPipeline();
  const packet = loadExample("invariant_promotion_packet");
  packet.promotion_basis = "multi_case";

  assert.throws(() => pipeline.compileDraft(packet));
});

test("invariant draft can be activated after compilation", () => {
  const pipeline = new InvariantPromotionPipeline();
  const packet = loadExample("invariant_promotion_packet");
  const draft = pipeline.compileDraft(packet);
  const active = pipeline.activateDraft(draft);

  assert.equal(active.status, "active");
});
