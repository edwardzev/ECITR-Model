const test = require("node:test");
const assert = require("node:assert/strict");

const { TacticPromotionPipeline } = require("../src/tactics/promotion");
const { loadExample } = require("./helpers/load-example");

test("tactic promotion compiles a draft tactic from a staging packet", () => {
  const pipeline = new TacticPromotionPipeline();
  const packet = loadExample("tactic_promotion_packet");

  const draft = pipeline.compileDraft(packet);

  assert.equal(draft.status, "draft");
  assert.equal(draft.id, packet.proposed_tactic_id);
});

test("tactic activation rejects already stale tactics", () => {
  const pipeline = new TacticPromotionPipeline();
  const packet = loadExample("tactic_promotion_packet");
  packet.expiry_at = "2020-01-01T00:00:00Z";
  delete packet.revalidate_at;

  const draft = pipeline.compileDraft(packet);
  assert.throws(() => pipeline.activateDraft(draft));
});

test("fresh tactic draft activates successfully", () => {
  const pipeline = new TacticPromotionPipeline();
  const packet = loadExample("tactic_promotion_packet");
  const draft = pipeline.compileDraft(packet);
  const active = pipeline.activateDraft(draft);

  assert.equal(active.status, "active");
});
