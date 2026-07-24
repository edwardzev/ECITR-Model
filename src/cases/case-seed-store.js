const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const { createSha256 } = require("../evidence/file-payload-store");
const { EcitrValidator, readJson } = require("../validation/validator");

const CASE_SEEDS_RELATIVE_DIR = path.join("staging", "case-seeds");
const CASE_SEED_ID_PREFIX = "case_seed_";
const CASE_SEED_ID_SALT = "agent-ops-run-case-seed:";

class CaseSeedStore {
  constructor({ rootDir, validator = new EcitrValidator() }) {
    if (!rootDir) {
      throw new Error("CaseSeedStore requires a rootDir.");
    }

    this.rootDir = path.resolve(rootDir);
    this.validator = validator;
    this.seedsDir = path.join(this.rootDir, CASE_SEEDS_RELATIVE_DIR);
  }

  upsertFromRun({
    runRef,
    runRecord,
    runEvidenceRef = null,
    workspaceId = null,
    sourceRunArtifactHash = null,
    now = null,
  }) {
    const nowIso = normalizeIsoNow(now);
    const nextSeed = buildCaseSeedFromRun({
      runRef,
      runRecord,
      runEvidenceRef,
      workspaceId,
      sourceRunArtifactHash,
      now: nowIso,
    });
    const existing = this.getSeed(nextSeed.case_seed_id);

    if (!existing) {
      this.writeSeed(nextSeed);
      return {
        status: "created",
        seed: nextSeed,
      };
    }

    if (existing.seed_packet_hash === nextSeed.seed_packet_hash) {
      const updated = {
        ...existing,
        source_run_artifact_hash: existing.source_run_artifact_hash ?? nextSeed.source_run_artifact_hash,
        evidence_links: mergeEvidenceLinks(existing.evidence_links, nextSeed.evidence_links),
        status: existing.status === "compiled"
          ? "compiled"
          : resolveSeedStatus(mergeEvidenceLinks(existing.evidence_links, nextSeed.evidence_links)),
        last_seen_at: nowIso,
      };
      this.writeSeed(updated);
      return {
        status: "seen_existing",
        seed: updated,
      };
    }

    if (existing.status === "compiled") {
      return {
        status: "compiled_conflict",
        seed: existing,
        attempted_seed_packet_hash: nextSeed.seed_packet_hash,
      };
    }

    const previousSeedPacketHashes = appendUnique(
      existing.previous_seed_packet_hashes ?? [],
      existing.seed_packet_hash,
    );
    const updated = {
      ...existing,
      run_ref: nextSeed.run_ref,
      session_ref: nextSeed.session_ref,
      thread_ref: nextSeed.thread_ref,
      project_id: nextSeed.project_id,
      workspace_id: nextSeed.workspace_id,
      seed_packet: nextSeed.seed_packet,
      seed_packet_hash: nextSeed.seed_packet_hash,
      source_run_artifact_hash: nextSeed.source_run_artifact_hash,
      evidence_links: mergeEvidenceLinks(existing.evidence_links, nextSeed.evidence_links),
      status: resolveSeedStatus(mergeEvidenceLinks(existing.evidence_links, nextSeed.evidence_links)),
      last_seen_at: nowIso,
      revision: existing.revision + 1,
      previous_seed_packet_hashes: previousSeedPacketHashes,
    };

    this.writeSeed(updated);
    return {
      status: "updated",
      seed: updated,
    };
  }

  attachSessionEvidence({ sessionRef, sessionEvidenceRef, now = null }) {
    assertNonEmptyString(sessionRef, "sessionRef");
    assertNonEmptyString(sessionEvidenceRef, "sessionEvidenceRef");

    const nowIso = normalizeIsoNow(now);
    const result = {
      matched: 0,
      attached: 0,
      seen_existing: 0,
      conflicts: 0,
    };

    for (const seed of this.listSeeds()) {
      if (seed.session_ref !== sessionRef) {
        continue;
      }

      result.matched += 1;
      if (seed.evidence_links.session_evidence_ref === sessionEvidenceRef) {
        result.seen_existing += 1;
        continue;
      }

      if (seed.evidence_links.session_evidence_ref) {
        result.conflicts += 1;
        continue;
      }

      const updated = {
        ...seed,
        evidence_links: {
          ...seed.evidence_links,
          session_evidence_ref: sessionEvidenceRef,
        },
        last_seen_at: nowIso,
      };
      this.writeSeed(updated);
      result.attached += 1;
    }

    return result;
  }

  attachChatEvidence({ threadRef, chatEvidenceRef, now = null }) {
    assertNonEmptyString(threadRef, "threadRef");
    assertNonEmptyString(chatEvidenceRef, "chatEvidenceRef");

    const nowIso = normalizeIsoNow(now);
    const result = {
      matched: 0,
      attached: 0,
      seen_existing: 0,
    };

    for (const seed of this.listSeeds()) {
      if (seed.thread_ref !== threadRef) {
        continue;
      }

      result.matched += 1;
      if (seed.evidence_links.chat_evidence_refs.includes(chatEvidenceRef)) {
        result.seen_existing += 1;
        continue;
      }

      const updated = {
        ...seed,
        evidence_links: {
          ...seed.evidence_links,
          chat_evidence_refs: [...seed.evidence_links.chat_evidence_refs, chatEvidenceRef],
        },
        last_seen_at: nowIso,
      };
      this.writeSeed(updated);
      result.attached += 1;
    }

    return result;
  }

  markCompiled(caseSeedId, { now = null } = {}) {
    assertNonEmptyString(caseSeedId, "caseSeedId");
    const seed = this.getSeed(caseSeedId);
    if (!seed) {
      throw new Error(`Case seed not found: ${caseSeedId}`);
    }

    const updated = {
      ...seed,
      status: "compiled",
      last_seen_at: normalizeIsoNow(now),
    };
    this.writeSeed(updated);
    return updated;
  }

  getSeed(caseSeedId) {
    const filePath = this.getSeedPath(caseSeedId);
    if (!fs.existsSync(filePath)) {
      return null;
    }

    return readJson(filePath);
  }

  listSeeds() {
    if (!fs.existsSync(this.seedsDir)) {
      return [];
    }

    return fs
      .readdirSync(this.seedsDir)
      .filter((entry) => entry.endsWith(".json"))
      .sort()
      .map((entry) => readJson(path.join(this.seedsDir, entry)));
  }

  writeSeed(seed) {
    this.validator.validateRecord("case_seed", seed);
    const filePath = this.getSeedPath(seed.case_seed_id);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(seed, null, 2)}\n`, "utf8");
    return {
      filePath,
      seed,
    };
  }

  getSeedPath(caseSeedId) {
    assertNonEmptyString(caseSeedId, "caseSeedId");
    return path.join(this.seedsDir, `${caseSeedId}.json`);
  }
}

function buildCaseSeedFromRun({
  runRef,
  runRecord,
  runEvidenceRef,
  workspaceId,
  sourceRunArtifactHash,
  now,
}) {
  assertNonEmptyString(runRef, "runRef");
  if (!runRecord || typeof runRecord !== "object" || Array.isArray(runRecord)) {
    throw new Error("Case seed creation requires a runRecord object.");
  }

  const closeout = runRecord.ecitr_closeout;
  if (closeout?.decision !== "candidate") {
    throw new Error("Case seed creation requires ecitr_closeout.decision = candidate.");
  }

  assertNonEmptyString(runRecord.project_id, "runRecord.project_id");
  assertNonEmptyString(runRecord.session_ref, "runRecord.session_ref");

  const evidenceLinks = {
    run_evidence_ref: runEvidenceRef ?? null,
    session_evidence_ref: null,
    chat_evidence_refs: [],
  };
  const seedPacket = cloneJson(closeout.seed);

  return {
    artifact_type: "ecitr_case_seed",
    source: "agent_ops_closeout",
    promotion_state: "staging",
    canonical: false,
    case_seed_id: buildCaseSeedId(runRef),
    run_ref: runRef,
    session_ref: runRecord.session_ref,
    thread_ref: typeof runRecord.thread_ref === "string" && runRecord.thread_ref.length > 0
      ? runRecord.thread_ref
      : null,
    project_id: runRecord.project_id,
    workspace_id: workspaceId ?? null,
    seed_packet: seedPacket,
    seed_packet_hash: hashJson(seedPacket),
    source_run_artifact_hash: sourceRunArtifactHash ?? null,
    evidence_links: evidenceLinks,
    status: resolveSeedStatus(evidenceLinks),
    imported_at: now,
    last_seen_at: now,
    revision: 1,
  };
}

function buildCaseSeedId(runRef) {
  assertNonEmptyString(runRef, "runRef");
  const digest = crypto.createHash("sha256").update(`${CASE_SEED_ID_SALT}${runRef}`).digest("hex");
  return `${CASE_SEED_ID_PREFIX}${digest}`;
}

function hashJson(value) {
  return createSha256(stableStringify(value));
}

function stableStringify(value) {
  return JSON.stringify(sortForStableJson(value));
}

function sortForStableJson(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => sortForStableJson(entry));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortForStableJson(value[key])]),
    );
  }

  return value;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function mergeEvidenceLinks(existingLinks, nextLinks) {
  return {
    run_evidence_ref: existingLinks.run_evidence_ref ?? nextLinks.run_evidence_ref ?? null,
    session_evidence_ref: existingLinks.session_evidence_ref ?? nextLinks.session_evidence_ref ?? null,
    chat_evidence_refs: uniqueStrings([
      ...(existingLinks.chat_evidence_refs ?? []),
      ...(nextLinks.chat_evidence_refs ?? []),
    ]),
  };
}

function resolveSeedStatus(evidenceLinks) {
  return evidenceLinks.run_evidence_ref ? "ready_for_review" : "pending_evidence";
}

function appendUnique(values, value) {
  return uniqueStrings([...values, value]);
}

function uniqueStrings(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.length > 0))];
}

function normalizeIsoNow(value) {
  if (value == null) {
    return new Date().toISOString();
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid ISO timestamp: ${value}`);
  }

  return parsed.toISOString();
}

function assertNonEmptyString(value, fieldName) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${fieldName} must be a non-empty string.`);
  }
}

module.exports = {
  CASE_SEEDS_RELATIVE_DIR,
  CaseSeedStore,
  buildCaseSeedFromRun,
  buildCaseSeedId,
  hashJson,
  stableStringify,
};
