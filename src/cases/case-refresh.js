const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const { CaseCompiler } = require("./case-compiler");
const { CaseSeedStore } = require("./case-seed-store");
const { CasePacketStore } = require("./staging-packet-store");
const { FileBackedCatalog } = require("../storage/file-backed-catalog");
const { EcitrValidator } = require("../validation/validator");
const { REPO_ROOT } = require("../validation/schema-registry");
const { buildParameterIndexes, getObservationsForRecord } = require("../parameters/retrieval");
const { resolveWorkspaceId } = require("../workspace/config");

const DEFAULT_CATALOG_ROOT = path.join(REPO_ROOT, ".local", "catalog");
const DEFAULT_DERIVATION_RULE_ID = "case-autodistill-run-v1";
const DEFAULT_AUTHORING_AGENT = "case-distiller";
const CASE_SEED_DERIVATION_RULE_ID = "case-seed-closeout-v1";
const CASE_SEED_AUTHORING_AGENT = "agent-ops-closeout";

function refreshCases({
  catalogRoot = DEFAULT_CATALOG_ROOT,
  dryRun = false,
  validator = new EcitrValidator(),
  catalog = new FileBackedCatalog({ rootDir: catalogRoot, validator }),
  packetStore = new CasePacketStore({ rootDir: catalogRoot, validator }),
  caseSeedStore = new CaseSeedStore({ rootDir: catalogRoot, validator }),
  compiler = new CaseCompiler({ validator }),
  derivationRuleId = DEFAULT_DERIVATION_RULE_ID,
  authoringAgent = DEFAULT_AUTHORING_AGENT,
  workspaceId = resolveWorkspaceId({ catalogRoot }),
  includeLegacyAutodistill = true,
} = {}) {
  const summary = {
    dry_run: dryRun,
    catalog_root: path.resolve(catalogRoot),
    workspace_id: workspaceId ?? null,
    derivation_rule_id: derivationRuleId,
    include_legacy_autodistill: includeLegacyAutodistill,
    scanned_evidence: 0,
    supported_evidence: 0,
    seed_case_seeds_scanned: 0,
    seed_case_seeds_supported: 0,
    seed_case_seeds_pending_evidence: 0,
    packets_written: 0,
    draft_cases_written: 0,
    skipped_existing_packets: 0,
    skipped_existing_cases: 0,
    skipped_unsupported: 0,
    errors: 0,
  };
  const parameterIndexes = buildParameterIndexes(catalog.loadRuntimeCatalogs());

  for (const seed of caseSeedStore.listSeeds()) {
    if (workspaceId && seed.workspace_id !== workspaceId) {
      continue;
    }

    summary.seed_case_seeds_scanned += 1;
    const packet = buildCompilationPacketFromCaseSeed(seed);
    if (!packet) {
      summary.seed_case_seeds_pending_evidence += 1;
      continue;
    }

    summary.seed_case_seeds_supported += 1;
    const existingPacket = packetStore.getPacket(packet.compilation_id);
    if (existingPacket) {
      summary.skipped_existing_packets += 1;
    } else if (!dryRun) {
      packetStore.writePacket(packet);
      summary.packets_written += 1;
    } else {
      summary.packets_written += 1;
    }

    const draftCase = compiler.compile(packet);
    const existingCase = catalog.getRecord("case", draftCase.case_id);
    if (existingCase) {
      summary.skipped_existing_cases += 1;
      if (!dryRun && seed.status !== "compiled") {
        caseSeedStore.markCompiled(seed.case_seed_id);
      }
      continue;
    }

    if (!dryRun) {
      catalog.writeRecord("case", draftCase);
      caseSeedStore.markCompiled(seed.case_seed_id);
    }
    summary.draft_cases_written += 1;
  }

  if (!includeLegacyAutodistill) {
    return summary;
  }

  for (const evidenceRecord of catalog.listRecords("evidence")) {
    if (workspaceId && evidenceRecord.workspace_id !== workspaceId) {
      continue;
    }

    summary.scanned_evidence += 1;

    let packet;
    try {
      packet = buildCompilationPacketFromEvidence(evidenceRecord, {
        catalogRoot,
        derivationRuleId,
        authoringAgent,
        parameterIndexes,
        workspaceId,
      });
    } catch (error) {
      summary.errors += 1;
      if (!summary.error_details) {
        summary.error_details = [];
      }
      summary.error_details.push({
        evidence_id: evidenceRecord.evidence_id,
        message: error.message,
      });
      continue;
    }

    if (!packet) {
      summary.skipped_unsupported += 1;
      continue;
    }

    summary.supported_evidence += 1;

    const existingPacket = packetStore.getPacket(packet.compilation_id);
    if (existingPacket) {
      summary.skipped_existing_packets += 1;
    } else if (!dryRun) {
      packetStore.writePacket(packet);
      summary.packets_written += 1;
    } else {
      summary.packets_written += 1;
    }

    const draftCase = compiler.compile(packet);
    const existingCase = catalog.getRecord("case", draftCase.case_id);
    if (existingCase) {
      summary.skipped_existing_cases += 1;
      continue;
    }

    if (!dryRun) {
      catalog.writeRecord("case", draftCase);
    }
    summary.draft_cases_written += 1;
  }

  return summary;
}

function buildCompilationPacketFromEvidence(
  evidenceRecord,
  {
    catalogRoot,
    derivationRuleId,
    authoringAgent,
    parameterIndexes = buildParameterIndexes({}),
    workspaceId = null,
  },
) {
  const payload = loadEvidencePayload(evidenceRecord, { catalogRoot });
  if (payload?.ecitr_closeout) {
    return null;
  }

  if (!isStructuredRunPayload(payload)) {
    return null;
  }

  const blockers = normalizeStringArray(payload.blockers);
  const openQuestions = [
    "Confirm or add applicability.when_to_apply before approval.",
    "Confirm or add applicability.when_not_to_apply before approval.",
  ];

  const packet = {
    compilation_id: createCompilationId(evidenceRecord.evidence_id, derivationRuleId),
    proposed_case_id: createStableCaseId(evidenceRecord.evidence_id),
    case_version: 1,
    evidence_refs: [evidenceRecord.evidence_id],
    problem_statement: payload.objective.trim(),
    context: {
      project_scope: evidenceRecord.project_scope,
      constraints: blockers,
      toolchain: [],
    },
    action_taken: formatList(payload.steps_completed),
    outcome: formatList(payload.findings),
    confidence: inferConfidence({ blockers, payload }),
    derived_at: evidenceRecord.captured_at,
    derivation_rule_id: derivationRuleId,
    authoring_agent: authoringAgent,
    open_questions: openQuestions,
  };
  const effectiveWorkspaceId = evidenceRecord.workspace_id ?? workspaceId ?? null;
  if (effectiveWorkspaceId) {
    packet.workspace_id = effectiveWorkspaceId;
  }
  const parameterObservationRefs = getObservationsForRecord("evidence", evidenceRecord, parameterIndexes)
    .map((observation) => observation.observation_id);
  if (parameterObservationRefs.length > 0) {
    packet.parameter_observation_refs = parameterObservationRefs;
  }

  if (blockers.length > 0) {
    packet.failure_mode = formatList(blockers);
  } else {
    packet.open_questions.push("Source evidence does not record an explicit failure_mode; confirm whether none was observed or add the specific failure mode before approval.");
  }

  return packet;
}

function buildCompilationPacketFromCaseSeed(seed) {
  if (!seed.evidence_links.run_evidence_ref) {
    return null;
  }

  const packet = {
    compilation_id: createCaseSeedCompilationId(seed.case_seed_id),
    proposed_case_id: createCaseSeedStableCaseId(seed.case_seed_id),
    case_version: 1,
    evidence_refs: uniqueEvidenceRefs([
      seed.evidence_links.run_evidence_ref,
      seed.evidence_links.session_evidence_ref,
      ...(seed.evidence_links.chat_evidence_refs ?? []),
    ]),
    problem_statement: seed.seed_packet.problem,
    context: {
      project_scope: "project",
      constraints: [seed.seed_packet.constraints],
      toolchain: [],
    },
    action_taken: seed.seed_packet.action_taken,
    outcome: seed.seed_packet.outcome,
    failure_mode: seed.seed_packet.failure_mode,
    applicability: {
      when_to_apply: [
        seed.seed_packet.future_decision,
        seed.seed_packet.activate_when,
        seed.seed_packet.plan_effect,
      ],
      when_not_to_apply: [seed.seed_packet.do_not_apply_when],
    },
    confidence: seed.seed_packet.confidence,
    derived_at: seed.imported_at,
    derivation_rule_id: CASE_SEED_DERIVATION_RULE_ID,
    authoring_agent: CASE_SEED_AUTHORING_AGENT,
    open_questions: [],
  };

  if (seed.workspace_id) {
    packet.workspace_id = seed.workspace_id;
  }

  return packet;
}

function loadEvidencePayload(evidenceRecord, { catalogRoot }) {
  const payloadPath = resolvePayloadPath(evidenceRecord, { catalogRoot });
  if (!payloadPath) {
    throw new Error("Evidence payload path could not be resolved.");
  }

  return JSON.parse(fs.readFileSync(payloadPath, "utf8"));
}

function resolvePayloadPath(evidenceRecord, { catalogRoot }) {
  if (!evidenceRecord.verbatim_payload_ref) {
    return null;
  }

  if (path.isAbsolute(evidenceRecord.verbatim_payload_ref)) {
    return evidenceRecord.verbatim_payload_ref;
  }

  return path.resolve(catalogRoot, evidenceRecord.verbatim_payload_ref);
}

function isStructuredRunPayload(payload) {
  return Boolean(
    payload &&
      typeof payload.objective === "string" &&
      normalizeStringArray(payload.steps_completed).length > 0 &&
      normalizeStringArray(payload.findings).length > 0,
  );
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((entry) => typeof entry === "string" && entry.trim().length > 0).map((entry) => entry.trim());
}

function formatList(entries) {
  return normalizeStringArray(entries)
    .map((entry, index) => `${index + 1}. ${entry}`)
    .join("\n");
}

function inferConfidence({ blockers, payload }) {
  let confidence = 0.64;
  if (blockers.length > 0) {
    confidence += 0.06;
  }

  if (normalizeStringArray(payload.lesson_candidates).length > 0) {
    confidence += 0.04;
  }

  return Math.min(0.8, confidence);
}

function createCompilationId(evidenceId, derivationRuleId) {
  return `ccp_${hashText(`${evidenceId}:${derivationRuleId}`).slice(0, 20)}`;
}

function createStableCaseId(evidenceId) {
  return `case_${hashText(evidenceId).slice(0, 20)}`;
}

function createCaseSeedCompilationId(caseSeedId) {
  return `ccp_${hashText(`case-seed:${caseSeedId}`).slice(0, 20)}`;
}

function createCaseSeedStableCaseId(caseSeedId) {
  return `case_${hashText(`case-seed:${caseSeedId}`).slice(0, 20)}`;
}

function uniqueEvidenceRefs(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.length > 0))];
}

function hashText(value) {
  return crypto.createHash("sha1").update(String(value)).digest("hex");
}

module.exports = {
  CASE_SEED_AUTHORING_AGENT,
  CASE_SEED_DERIVATION_RULE_ID,
  DEFAULT_AUTHORING_AGENT,
  DEFAULT_CATALOG_ROOT,
  DEFAULT_DERIVATION_RULE_ID,
  buildCompilationPacketFromCaseSeed,
  buildCompilationPacketFromEvidence,
  createCaseSeedCompilationId,
  createCaseSeedStableCaseId,
  createCompilationId,
  createStableCaseId,
  refreshCases,
};
