const test = require("node:test");
const assert = require("node:assert/strict");

const { CaseCompiler } = require("../src/cases/case-compiler");
const { EcitrValidator } = require("../src/validation/validator");
const { loadExample } = require("./helpers/load-example");

test("case compiler turns a compilation packet into a schema-valid draft case", () => {
  const compiler = new CaseCompiler();
  const validator = new EcitrValidator();
  const packet = loadExample("case_compilation_packet");

  const compiled = compiler.compile(packet);

  assert.equal(compiled.status, "draft");
  assert.equal(compiled.review_state, "draft");
  assert.equal(compiled.case_id, packet.proposed_case_id);
  assert.doesNotThrow(() => validator.validateRecord("case", compiled));
});

test("case compiler refuses packets without evidence refs", () => {
  const compiler = new CaseCompiler();
  const packet = loadExample("case_compilation_packet");
  packet.evidence_refs = [];

  assert.throws(() => compiler.compile(packet));
});

test("compiled draft must be reviewed before activation", () => {
  const compiler = new CaseCompiler();
  const packet = loadExample("case_compilation_packet");
  const compiled = compiler.compile(packet);

  assert.throws(() => compiler.activate(compiled));

  const reviewed = compiler.markReviewed(compiled);
  const active = compiler.activate(reviewed);

  assert.equal(active.status, "active");
  assert.equal(active.review_state, "approved");
});

test("compiler allows partial drafts but activation still requires complete framing", () => {
  const compiler = new CaseCompiler();
  const packet = {
    compilation_id: "ccp_partial_draft_001",
    proposed_case_id: "case_partial_draft_001",
    evidence_refs: ["ev_partial_001"],
    problem_statement: "The source evidence captures the task but not every framing field.",
    action_taken: "1. Extract the explicit task.\n2. Preserve the missing framing as open questions.",
    outcome: "A draft case was produced without fabricating failure mode or applicability.",
    confidence: 0.64,
    derivation_rule_id: "case-autodistill-run-v1",
    open_questions: [
      "Add failure_mode before approval.",
      "Add applicability.when_to_apply and applicability.when_not_to_apply before approval.",
    ],
  };

  const compiled = compiler.compile(packet);
  const reviewed = compiler.markReviewed(compiled);

  assert.equal(compiled.status, "draft");
  assert.deepEqual(compiled.open_questions, packet.open_questions);
  assert.throws(() => compiler.activate(reviewed), /Non-draft cases must carry complete framing fields/);
});
