const path = require("node:path");

const { DEFAULT_CATALOG_ROOT } = require("../cases/case-refresh");
const { InvariantDiscoverySurface } = require("./discovery");
const { InvariantPromotionPipeline } = require("./promotion");
const { InvariantPromotionPacketStore } = require("./promotion-packet-store");
const { ReviewWorkflow } = require("../review/workflow");
const { FileBackedCatalog } = require("../storage/file-backed-catalog");
const { EcitrValidator } = require("../validation/validator");
const crypto = require("node:crypto");

class InvariantReviewSurface {
  constructor({
    catalogRoot = DEFAULT_CATALOG_ROOT,
    validator = new EcitrValidator(),
    discovery = new InvariantDiscoverySurface({ catalogRoot, validator }),
    pipeline = new InvariantPromotionPipeline({ validator }),
    reviewWorkflow = new ReviewWorkflow({ validator }),
    packetStore = new InvariantPromotionPacketStore({ rootDir: catalogRoot, validator }),
  } = {}) {
    this.catalogRoot = path.resolve(catalogRoot);
    this.validator = validator;
    this.catalog = new FileBackedCatalog({ rootDir: this.catalogRoot, validator });
    this.discovery = discovery;
    this.pipeline = pipeline;
    this.reviewWorkflow = reviewWorkflow;
    this.packetStore = packetStore;
  }

  inspectInvariant(invariantId) {
    const record = this.catalog.getRecord("invariant", invariantId);
    const packet = record?.id
      ? this.packetStore.listPackets().find((candidate) => candidate.proposed_invariant_id === record.id) ?? null
      : null;

    return {
      invariant: record,
      staged_promotion_packet: packet,
    };
  }

  promoteCandidate({
    entry,
    reviewer,
    rationale,
    reviewedAt,
    dryRun = false,
  }) {
    if (!entry) {
      throw new Error("promoteCandidate requires an entry.");
    }
    if (!reviewer) {
      throw new Error("promoteCandidate requires a reviewer.");
    }
    if (!rationale) {
      throw new Error("promoteCandidate requires a rationale.");
    }

    const preparedEntry = {
      ...entry,
      created_at: entry.created_at ?? reviewedAt,
      reviewer,
      rationale,
      reviewed_at: reviewedAt,
    };

    const evaluation = this.discovery.evaluateCandidate(preparedEntry);

    if (evaluation.actual_decision !== "approve") {
      const error = new Error("candidate is not promotion-ready");
      error.readiness = evaluation;
      throw error;
    }

    const { packet } = this.discovery.preparePromotionPacket(preparedEntry);
    const draft = this.pipeline.compileDraft(packet);
    const approval = this.reviewWorkflow.applyDecision({
      recordType: "invariant",
      record: draft,
      decisionPacket: {
        decision_id: entry.decision_id ?? createDecisionId(packet.proposed_invariant_id),
        record_type: "invariant",
        record_id: draft.id,
        decision: "approve",
        reviewer,
        rationale,
        reviewed_at: reviewedAt,
      },
    });

    const nextRecord = {
      ...approval.nextRecord,
      updated_at: reviewedAt,
    };
    const auditEntry = {
      ...approval.auditEntry,
      record_snapshot_hash: createRecordSnapshotHash(nextRecord),
    };

    if (dryRun) {
      return {
        dry_run: true,
        packet,
        draft,
        next_record: nextRecord,
        audit_entry: auditEntry,
      };
    }

    const packetWrite = this.packetStore.writePacket(packet);
    this.catalog.writeRecord("invariant", draft, { overwrite: false });
    const recordWrite = this.catalog.writeRecord("invariant", nextRecord, { overwrite: true });
    const auditWrite = this.catalog.writeRecord("review_audit_entry", auditEntry);

    return {
      dry_run: false,
      packet_write: packetWrite,
      record_write: recordWrite,
      audit_write: auditWrite,
      next_record: nextRecord,
    };
  }
}

function createDecisionId(invariantId) {
  return `review_invariant_${invariantId}_approve_001`;
}

function createRecordSnapshotHash(record) {
  return `sha256:${crypto.createHash("sha256").update(JSON.stringify(record)).digest("hex")}`;
}

module.exports = {
  InvariantReviewSurface,
};
