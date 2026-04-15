const STATUS_TRANSITIONS = Object.freeze({
  case: Object.freeze({
    draft: ["active", "deprecated"],
    active: ["deprecated", "superseded"],
    deprecated: ["superseded"],
    superseded: [],
  }),
  invariant: Object.freeze({
    draft: ["active", "rejected", "deprecated"],
    active: ["superseded", "deprecated"],
    superseded: ["deprecated"],
    deprecated: [],
    rejected: [],
  }),
  tactic: Object.freeze({
    draft: ["active", "rejected", "deprecated"],
    active: ["superseded", "deprecated"],
    superseded: ["deprecated"],
    deprecated: [],
    rejected: [],
  }),
});

function canTransition(recordType, fromStatus, toStatus) {
  const transitions = STATUS_TRANSITIONS[recordType];
  if (!transitions) {
    throw new Error(`No lifecycle transitions registered for: ${recordType}`);
  }

  return transitions[fromStatus]?.includes(toStatus) ?? false;
}

function assertTransition(recordType, fromStatus, toStatus) {
  if (!canTransition(recordType, fromStatus, toStatus)) {
    throw new Error(
      `Invalid ${recordType} transition: ${String(fromStatus)} -> ${String(toStatus)}`,
    );
  }
}

function assertLifecycleRecord(recordType, record) {
  switch (recordType) {
    case "evidence":
      return assertEvidenceRecord(record);
    case "case":
      return assertCaseRecord(record);
    case "invariant":
      return assertInvariantRecord(record);
    case "tactic":
      return assertTacticRecord(record);
    default:
      throw new Error(`Unsupported lifecycle record type: ${recordType}`);
  }
}

function assertEvidenceRecord(record) {
  if (record.immutable !== true) {
    throw new Error("Evidence records must remain immutable.");
  }

  if (record.parent_evidence_id && record.parent_evidence_id === record.evidence_id) {
    throw new Error("Evidence cannot name itself as its parent.");
  }

  if (record.correction_of && record.correction_of === record.evidence_id) {
    throw new Error("Evidence cannot correct itself.");
  }

  return record;
}

function assertCaseRecord(record) {
  if (record.case_version < 1) {
    throw new Error("Case version must be at least 1.");
  }

  if (record.derived_from_case_id && record.derived_from_case_id === record.case_id) {
    throw new Error("Case cannot derive from itself.");
  }

  if (record.supersedes_case_id && record.supersedes_case_id === record.case_id) {
    throw new Error("Case cannot supersede itself.");
  }

  if (record.status === "superseded" && !record.supersedes_case_id) {
    throw new Error("Superseded cases must cite the superseded case series.");
  }

  if (record.status === "active" && record.review_state !== "approved") {
    throw new Error("Active cases must be approved.");
  }

  if (record.status === "draft") {
    if (!hasDraftSignal(record)) {
      throw new Error("Draft cases must preserve at least one explicit field or open question.");
    }
    return record;
  }

  if (record.status === "deprecated") {
    return record;
  }

  if (!hasCompleteCaseFraming(record)) {
    throw new Error("Non-draft cases must carry complete framing fields.");
  }

  if (!hasSubstantiveCaseApplicability(record)) {
    throw new Error("Non-draft cases must carry substantive applicability, not boilerplate.");
  }

  if ((record.open_questions ?? []).length > 0) {
    throw new Error("Non-draft cases cannot retain unresolved open questions.");
  }

  return record;
}

function hasDraftSignal(record) {
  return Boolean(
    record.problem_statement ||
      record.action_taken ||
      record.outcome ||
      record.failure_mode ||
      record.context ||
      record.applicability ||
      (record.open_questions ?? []).length > 0,
  );
}

function hasCompleteCaseFraming(record) {
  const hasProblem = typeof record.problem_statement === "string" && record.problem_statement.trim().length > 0;
  const hasAction = typeof record.action_taken === "string" && record.action_taken.trim().length > 0;
  const hasOutcome = typeof record.outcome === "string" && record.outcome.trim().length > 0;
  const hasFailureMode = typeof record.failure_mode === "string" && record.failure_mode.trim().length > 0;
  const hasContext =
    record.context &&
    typeof record.context.project_scope === "string" &&
    Array.isArray(record.context.constraints) &&
    Array.isArray(record.context.toolchain);
  const hasApplicability =
    record.applicability &&
    Array.isArray(record.applicability.when_to_apply) &&
    Array.isArray(record.applicability.when_not_to_apply);

  return Boolean(hasProblem && hasAction && hasOutcome && hasFailureMode && hasContext && hasApplicability);
}

function hasSubstantiveCaseApplicability(record) {
  const whenToApply = normalizeApplicabilityLines(record.applicability?.when_to_apply);
  const whenNotToApply = normalizeApplicabilityLines(record.applicability?.when_not_to_apply);
  const problem = normalizeText(record.problem_statement);

  if (whenToApply.length === 0 || whenNotToApply.length === 0) {
    return false;
  }

  const hasSpecificWhenToApply = whenToApply.some((line) => {
    if (isBoilerplateApplicabilityLine(line)) {
      return false;
    }
    if (isBoundaryTemplateApplicabilityLine(line)) {
      return false;
    }
    if (isIncidentalApplicabilityLine(line)) {
      return false;
    }
    if (isWeakAnalyticalApplicabilityLine(line)) {
      return false;
    }
    if (problem && (line === problem || line.includes(problem))) {
      return false;
    }
    return true;
  });

  const hasSpecificWhenNotToApply = whenNotToApply.some((line) => !isBoilerplateApplicabilityLine(line));
  return hasSpecificWhenToApply && hasSpecificWhenNotToApply;
}

function explainCaseCompleteness(record) {
  const reasons = [];

  if (!(typeof record.problem_statement === "string" && record.problem_statement.trim().length > 0)) {
    reasons.push("problem_statement is missing");
  }

  if (!(typeof record.action_taken === "string" && record.action_taken.trim().length > 0)) {
    reasons.push("action_taken is missing");
  } else if (!hasStrongSubstantiveAction(record.action_taken)) {
    reasons.push("action_taken must contain at least one substantive intervention or evidence-capture step");
  }

  if (!(typeof record.outcome === "string" && record.outcome.trim().length > 0)) {
    reasons.push("outcome is missing");
  }

  if (!(typeof record.failure_mode === "string" && record.failure_mode.trim().length > 0)) {
    reasons.push("failure_mode is missing");
  } else if (isResolvedBoundaryText(record.failure_mode) || isProcessOnlyBoundaryText(record.failure_mode)) {
    reasons.push("failure_mode must describe an actual unresolved failure or limitation");
  }

  if (!record.context || typeof record.context.project_scope !== "string") {
    reasons.push("context.project_scope is missing");
  }

  if (!record.context || !Array.isArray(record.context.constraints)) {
    reasons.push("context.constraints is missing");
  }

  if (!record.context || !Array.isArray(record.context.toolchain)) {
    reasons.push("context.toolchain is missing");
  }

  if (!record.applicability || !Array.isArray(record.applicability.when_to_apply)) {
    reasons.push("applicability.when_to_apply is missing");
  }

  if (!record.applicability || !Array.isArray(record.applicability.when_not_to_apply)) {
    reasons.push("applicability.when_not_to_apply is missing");
  }

  if (record.applicability && Array.isArray(record.applicability.when_to_apply)) {
    const whenToApply = normalizeApplicabilityLines(record.applicability.when_to_apply);
    const problem = normalizeText(record.problem_statement);
    const hasSpecificWhenToApply = whenToApply.some((line) => {
      if (isBoilerplateApplicabilityLine(line)) {
        return false;
      }
      if (isBoundaryTemplateApplicabilityLine(line)) {
        return false;
      }
      if (isIncidentalApplicabilityLine(line)) {
        return false;
      }
      if (isWeakAnalyticalApplicabilityLine(line)) {
        return false;
      }
      if (problem && (line === problem || line.includes(problem))) {
        return false;
      }
      return true;
    });
    if (!hasSpecificWhenToApply) {
      reasons.push("applicability.when_to_apply must contain at least one substantive reuse condition");
    }
  }

  if (record.applicability && Array.isArray(record.applicability.when_not_to_apply)) {
    const whenNotToApply = normalizeApplicabilityLines(record.applicability.when_not_to_apply);
    if (!whenNotToApply.some((line) => !isBoilerplateApplicabilityLine(line))) {
      reasons.push("applicability.when_not_to_apply must contain at least one substantive exclusion condition");
    }
  }

  if ((record.open_questions ?? []).length > 0) {
    reasons.push("open_questions must be resolved");
  }

  return reasons;
}

function normalizeApplicabilityLines(lines) {
  if (!Array.isArray(lines)) {
    return [];
  }
  return lines.map((line) => normalizeText(line)).filter(Boolean);
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function isBoilerplateApplicabilityLine(line) {
  return (
    line.startsWith("when handling the same case-shaped problem:") ||
    line.startsWith("when any of the recorded constraints or blockers no longer holds") ||
    line.startsWith("when the runtime, scheduling surface, or enforcement mechanism is materially different")
  );
}

function isBoundaryTemplateApplicabilityLine(line) {
  return line.startsWith("when the expected operating conditions still match this record");
}

function isIncidentalApplicabilityLine(line) {
  return [
    "opened agent-ops memory",
    "opened agent memory session",
    "opened a memory session",
    "opened a fresh",
    "opened memory session",
    "opened the required memory session",
    "opened a new memory session",
    "opened project memory",
    "inspected the local",
    "inspected local",
    "registered the workspace",
    "registered /users/",
    "checked reasoning baseline",
    "checked the configured reasoning baseline",
    "loaded reasoning-advisor",
    "loaded reasoning advisor",
    "reviewed recent",
    "read the mandatory repo documents",
    "read repository deployment notes",
    "read the canonical workflow",
    "re-read the repository doctrine",
    "reviewed the current",
    "queried official microsoft learn docs",
    "enumerated available azure subscriptions",
    "confirmed azure login under",
    "started the wa mailer next.js dev server",
    "located the airtable token",
    "wrote the required airtable variables",
    "wrote airtable variables",
    "created a gmail draft",
    "added a github issue comment",
    "recorded in github issue",
    "recorded provider capability confirmation",
    "grouped available runs and sessions",
    "confirmed the ecitr permanent evidence catalog",
    "reviewed the frontend skill guidance",
    "reviewed the local next.js",
    "inspected git graph",
    "inspected representative run",
    "inspected the orders page and global styles",
    "attempted to access chatgpt.com",
    "created a clean temporary worktree",
    "built the app successfully with the real .env.local",
    "created policy-level documents",
  ].some((pattern) => line.includes(pattern));
}

function isWeakAnalyticalApplicabilityLine(line) {
  return [
    "when the operator needs to execute the same kind of intervention captured here: read ",
    "when the operator needs to execute the same kind of intervention captured here: re-read ",
    "when the operator needs to execute the same kind of intervention captured here: reviewed ",
    "when the operator needs to execute the same kind of intervention captured here: compared ",
    "when the operator needs to execute the same kind of intervention captured here: inspected ",
    "when the operator needs to execute the same kind of intervention captured here: detected that port",
    "when the operator needs to execute the same kind of intervention captured here: created a canonical",
    "when the operator needs to execute the same kind of intervention captured here: added phase 2 governance artifacts",
    "when the operator needs to execute the same kind of intervention captured here: updated the target architecture",
    "when the operator needs to execute the same kind of intervention captured here: updated target architecture",
  ].some((pattern) => line.startsWith(pattern));
}

function hasStrongSubstantiveAction(value) {
  return splitStructuredLines(value).some((line) => isStrongInterventionActionLine(line));
}

function splitStructuredLines(value) {
  if (typeof value !== "string") {
    return [];
  }
  return value
    .split(/\r?\n+/)
    .map((line) => line.replace(/^\s*\d+\.\s*/, "").trim())
    .filter(Boolean);
}

function isStrongInterventionActionLine(line) {
  const normalized = normalizeText(line);
  if (!normalized) {
    return false;
  }
  if (isIncidentalApplicabilityLine(normalized) || isWeakAnalyticalActionLine(normalized)) {
    return false;
  }

  const blockedTargets = [
    "runbook",
    "runbooks",
    "checklist",
    "checklists",
    "governance",
    "target architecture",
    "state governance",
    "github issue",
    "issues",
    "docs/",
    "doctrine",
    "notes",
    "note ",
    "recommendation",
    "recommendations",
    "tracker",
    "template",
    "templates",
    "morning review",
    "live corpus",
    "session/run/draft health",
    "test suite",
    "smoke check",
    "smoke validation",
  ];
  if (blockedTargets.some((pattern) => normalized.includes(pattern))) {
    return false;
  }

  return [
    "added ",
    "expanded ",
    "patched ",
    "removed ",
    "set ",
    "enabled ",
    "deployed ",
    "implemented ",
    "extended ",
    "imported ",
    "uploaded ",
    "replayed ",
    "reproduced ",
    "executed ",
    "queried ",
    "collected ",
    "captured ",
    "fetched ",
    "preserved ",
    "provisioned ",
    "initialized ",
    "installed ",
    "configured ",
    "scaffolded ",
    "built ",
    "ran ",
    "backed up ",
    "bumped ",
    "created resource group",
    "created application insights",
    "created a private git",
    "created a local ignored .env",
    "created a repo-level agents.md",
    "updated the runtime contract",
    "wrote a project policy record",
    "updated the global codex agents file",
    "created an external evidence directory",
    "created a second external evidence directory",
  ].some((pattern) => normalized.startsWith(pattern));
}

function isWeakAnalyticalActionLine(line) {
  return [
    "read ",
    "re-read ",
    "reviewed ",
    "compared ",
    "inspected ",
    "detected that port",
    "created a canonical",
    "added phase 2 governance artifacts",
    "updated the target architecture",
    "updated target architecture",
  ].some((pattern) => line.startsWith(pattern));
}

function isResolvedBoundaryText(value) {
  const normalized = normalizeText(value);
  return (
    normalized.startsWith("no blocker remains") ||
    normalized.startsWith("no blocker for") ||
    normalized.includes("now stacks cleanly") ||
    normalized.includes("no longer wastes height") ||
    normalized.startsWith("the mobile header now ") ||
    normalized.startsWith("the filter panel no longer ")
  );
}

function isProcessOnlyBoundaryText(value) {
  const normalized = normalizeText(value);
  return [
    "not against a deployed production url",
    "have not been deployed in this thread",
    "has not been deployed in this thread",
    "not been deployed in this thread",
  ].some((pattern) => normalized.includes(pattern));
}

function assertInvariantRecord(record) {
  if (record.status === "superseded" && !record.superseded_by) {
    throw new Error("Superseded invariants must point to the newer invariant.");
  }

  if (record.supersedes && record.supersedes === record.id) {
    throw new Error("Invariant cannot supersede itself.");
  }

  if (record.superseded_by && record.superseded_by === record.id) {
    throw new Error("Invariant cannot point to itself as superseded_by.");
  }

  if (record.status === "rejected" && record.supersedes) {
    throw new Error("Rejected invariants cannot supersede active lineage.");
  }

  return record;
}

function assertTacticRecord(record) {
  if (record.status === "superseded" && !record.superseded_by) {
    throw new Error("Superseded tactics must point to the newer tactic.");
  }

  if (record.supersedes && record.supersedes === record.id) {
    throw new Error("Tactic cannot supersede itself.");
  }

  if (record.superseded_by && record.superseded_by === record.id) {
    throw new Error("Tactic cannot point to itself as superseded_by.");
  }

  if (record.status === "rejected" && record.supersedes) {
    throw new Error("Rejected tactics cannot supersede active lineage.");
  }

  return record;
}

function assertCaseRevision(previousRecord, nextRecord) {
  if (previousRecord.case_id !== nextRecord.case_id) {
    throw new Error("Case revision must keep the same case_id.");
  }

  if (nextRecord.case_version <= previousRecord.case_version) {
    throw new Error("Case revision must increment case_version.");
  }
}

function assertSupersessionPair(recordType, olderRecord, newerRecord) {
  if (recordType === "case") {
    if (newerRecord.supersedes_case_id !== olderRecord.case_id) {
      throw new Error("New case must cite the case series it supersedes.");
    }

    if (olderRecord.status !== "superseded") {
      throw new Error("Older case must already be marked superseded.");
    }

    return;
  }

  if (recordType === "invariant" || recordType === "tactic") {
    if (olderRecord.series_key !== newerRecord.series_key) {
      throw new Error(`${recordType} supersession must remain in the same series_key.`);
    }

    if (newerRecord.supersedes !== olderRecord.id) {
      throw new Error(`New ${recordType} must point to the older record with supersedes.`);
    }

    if (olderRecord.superseded_by !== newerRecord.id) {
      throw new Error(`Older ${recordType} must point forward with superseded_by.`);
    }

    if (olderRecord.status !== "superseded") {
      throw new Error(`Older ${recordType} must already be marked superseded.`);
    }

    if (newerRecord.version <= olderRecord.version) {
      throw new Error(`${recordType} supersession must increment version.`);
    }

    return;
  }

  throw new Error(`Supersession is not supported for record type: ${recordType}`);
}

module.exports = {
  STATUS_TRANSITIONS,
  canTransition,
  assertTransition,
  assertLifecycleRecord,
  assertCaseRevision,
  assertSupersessionPair,
  explainCaseCompleteness,
  hasCompleteCaseFraming,
  hasSubstantiveCaseApplicability,
  isProcessOnlyBoundaryText,
  isStrongInterventionActionLine,
  isResolvedBoundaryText,
};
