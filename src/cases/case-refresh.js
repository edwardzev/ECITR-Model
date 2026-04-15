const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const { CaseCompiler } = require("./case-compiler");
const { CasePacketStore } = require("./staging-packet-store");
const { FileBackedCatalog } = require("../storage/file-backed-catalog");
const { EcitrValidator } = require("../validation/validator");
const { REPO_ROOT } = require("../validation/schema-registry");
const { buildParameterIndexes, getObservationsForRecord } = require("../parameters/retrieval");

const DEFAULT_CATALOG_ROOT = path.join(REPO_ROOT, ".local", "catalog");
const DEFAULT_DERIVATION_RULE_ID = "case-autodistill-run-v1";
const DEFAULT_AUTHORING_AGENT = "case-distiller";

function refreshCases({
  catalogRoot = DEFAULT_CATALOG_ROOT,
  dryRun = false,
  validator = new EcitrValidator(),
  catalog = new FileBackedCatalog({ rootDir: catalogRoot, validator }),
  packetStore = new CasePacketStore({ rootDir: catalogRoot, validator }),
  compiler = new CaseCompiler({ validator }),
  derivationRuleId = DEFAULT_DERIVATION_RULE_ID,
  authoringAgent = DEFAULT_AUTHORING_AGENT,
} = {}) {
  const summary = {
    dry_run: dryRun,
    catalog_root: path.resolve(catalogRoot),
    derivation_rule_id: derivationRuleId,
    scanned_evidence: 0,
    supported_evidence: 0,
    packets_written: 0,
    draft_cases_written: 0,
    skipped_existing_packets: 0,
    skipped_existing_cases: 0,
    skipped_unsupported: 0,
    errors: 0,
  };
  const parameterIndexes = buildParameterIndexes(catalog.loadRuntimeCatalogs());

  for (const evidenceRecord of catalog.listRecords("evidence")) {
    summary.scanned_evidence += 1;

    let packet;
    try {
      packet = buildCompilationPacketFromEvidence(evidenceRecord, {
        catalogRoot,
        derivationRuleId,
        authoringAgent,
        parameterIndexes,
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
  },
) {
  const payload = loadEvidencePayload(evidenceRecord, { catalogRoot });
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

function hashText(value) {
  return crypto.createHash("sha1").update(String(value)).digest("hex");
}

module.exports = {
  DEFAULT_AUTHORING_AGENT,
  DEFAULT_CATALOG_ROOT,
  DEFAULT_DERIVATION_RULE_ID,
  buildCompilationPacketFromEvidence,
  createCompilationId,
  createStableCaseId,
  refreshCases,
};
