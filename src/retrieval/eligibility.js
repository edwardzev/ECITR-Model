const { evaluateTacticFreshness } = require("../tactics/freshness");

function evaluateRetrievalEligibility({
  layer,
  record,
  request,
  plan,
  now = new Date(),
} = {}) {
  const recordId = getRecordId(layer, record);

  if (layer !== "evidence" && record.status !== "active") {
    return {
      eligible: false,
      exclude: true,
      code: "inactive_status",
      message: `excluded ${layer.slice(0, -1)} ${recordId}: status ${record.status} is not retrievable`,
    };
  }

  if (
    layer === "cases"
    && record.status === "active"
    && record.review_state !== "approved"
  ) {
    return {
      eligible: false,
      exclude: true,
      code: "case_not_approved",
      message: `excluded case ${recordId}: active case must be approved for retrieval`,
    };
  }

  if (layer === "tactics") {
    const freshness = evaluateTacticFreshness(record, { now });
    if (!freshness.usable) {
      return {
        eligible: false,
        exclude: true,
        code: "tactic_unusable",
        message: `excluded tactic ${recordId}: ${freshness.reasons.join("; ")}`,
      };
    }
  }

  if (layer === "cases") {
    const scope = record.context?.project_scope;
    if (hasScopeConflict({ scope, request })) {
      return {
        eligible: false,
        exclude: true,
        code: "scope_conflict",
        message: `excluded case ${recordId}: scope ${scope} conflicts with request ${request.project_scope}`,
      };
    }
  }

  if (layer === "evidence") {
    const scope = record.project_scope;
    if (hasScopeConflict({ scope, request })) {
      return {
        eligible: false,
        exclude: true,
        code: "scope_conflict",
        message: `excluded evidence ${recordId}: scope ${scope} conflicts with request ${request.project_scope}`,
      };
    }
  }

  return {
    eligible: true,
    exclude: false,
    code: null,
    message: null,
  };
}

function hasScopeConflict({ scope, request }) {
  return (
    scope
    && scope !== "global"
    && request.project_scope !== "global"
    && scope !== request.project_scope
  );
}

function getRecordId(layer, record) {
  switch (layer) {
    case "tactics":
    case "invariants":
      return record.id;
    case "cases":
      return record.case_id;
    case "evidence":
      return record.evidence_id;
    default:
      throw new Error(`Unsupported layer: ${layer}`);
  }
}

module.exports = {
  evaluateRetrievalEligibility,
  getRecordId,
};
