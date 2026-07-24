const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildEvidenceCorrectionIndex,
  compareExpectedEvidenceToCurrent,
  getCurrentEvidenceRecords,
  resolveLatestEvidenceCorrection,
  withCurrentEvidenceRecords,
} = require("../src/evidence/corrections");

function evidence(evidenceId, overrides = {}) {
  return {
    evidence_id: evidenceId,
    workspace_id: "legacy_workspace",
    source_locator: `/source/${evidenceId}`,
    ...overrides,
  };
}

test("evidence correction chains resolve to one current immutable record", () => {
  const original = evidence("ev_original");
  const firstCorrection = evidence("ev_correction_1", {
    correction_of: original.evidence_id,
    workspace_id: "workspace_one",
  });
  const secondCorrection = evidence("ev_correction_2", {
    correction_of: firstCorrection.evidence_id,
    workspace_id: "workspace_two",
  });
  const records = [original, firstCorrection, secondCorrection];
  const index = buildEvidenceCorrectionIndex(records);

  assert.equal(resolveLatestEvidenceCorrection(index, original.evidence_id), secondCorrection);
  assert.deepEqual(getCurrentEvidenceRecords(records), [secondCorrection]);

  const catalogs = { evidence: records, cases: [] };
  Object.defineProperty(catalogs, "__catalogRoot", {
    value: "/tmp/catalog",
    enumerable: false,
  });
  const current = withCurrentEvidenceRecords(catalogs);
  assert.deepEqual(current.evidence, [secondCorrection]);
  assert.equal(current.__catalogRoot, "/tmp/catalog");
});

test("evidence correction graphs fail closed on missing, ambiguous, or cyclic lineage", () => {
  assert.throws(
    () => buildEvidenceCorrectionIndex([
      evidence("ev_orphan", { correction_of: "ev_missing" }),
    ]),
    /references missing evidence/,
  );

  assert.throws(
    () => buildEvidenceCorrectionIndex([
      evidence("ev_original"),
      evidence("ev_left", { correction_of: "ev_original" }),
      evidence("ev_right", { correction_of: "ev_original" }),
    ]),
    /ambiguous corrections/,
  );

  assert.throws(
    () => buildEvidenceCorrectionIndex([
      evidence("ev_left", { correction_of: "ev_right" }),
      evidence("ev_right", { correction_of: "ev_left" }),
    ]),
    /cycle detected/,
  );
});

test("import comparison treats a matching correction as canonical and preserves conflicts", () => {
  const original = evidence("ev_original");
  const correction = evidence("ev_corrected", {
    correction_of: original.evidence_id,
    workspace_id: "correct_workspace",
    source_locator: original.source_locator,
  });
  const index = buildEvidenceCorrectionIndex([original, correction]);
  const diff = (left, right) => ["workspace_id", "source_locator"]
    .filter((key) => left[key] !== right[key]);

  const matching = compareExpectedEvidenceToCurrent({
    index,
    expectedRecord: {
      ...original,
      workspace_id: "correct_workspace",
    },
    diffEvidenceRecords: diff,
  });
  assert.equal(matching.currentRecord, correction);
  assert.deepEqual(matching.mismatches, []);

  const conflicting = compareExpectedEvidenceToCurrent({
    index,
    expectedRecord: {
      ...original,
      workspace_id: "wrong_workspace",
    },
    diffEvidenceRecords: diff,
  });
  assert.deepEqual(conflicting.mismatches, ["workspace_id"]);
});
