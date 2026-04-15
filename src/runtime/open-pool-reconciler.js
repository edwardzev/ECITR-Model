const crypto = require("node:crypto");
const path = require("node:path");

const { DEFAULT_CATALOG_ROOT } = require("../cases/case-refresh");
const { FileBackedCatalog } = require("../storage/file-backed-catalog");
const { DiscoveryReconciliationPacketStore } = require("./discovery-reconciliation-packet-store");

function reconcileOpenPools({
  catalogRoot = DEFAULT_CATALOG_ROOT,
  reconciledAt = new Date().toISOString(),
  dryRun = false,
  catalog = new FileBackedCatalog({ rootDir: catalogRoot }),
  store = new DiscoveryReconciliationPacketStore({ rootDir: catalogRoot }),
} = {}) {
  return {
    evidence_to_case: reconcileEvidenceToCasePool({ catalog, store, reconciledAt, dryRun }),
    case_to_invariant: reconcileCaseToInvariantPool({ catalog, store, reconciledAt, dryRun }),
    invariant_to_tactic: reconcileInvariantToTacticPool({ catalog, store, reconciledAt, dryRun }),
  };
}

function reconcileEvidenceToCasePool({ catalog, store, reconciledAt, dryRun }) {
  const evidenceRecords = catalog.listRecords("evidence");
  const cases = catalog.listRecords("case");
  const caseRefsByEvidence = new Map();

  for (const record of cases) {
    for (const evidenceId of record.evidence_refs ?? []) {
      if (!caseRefsByEvidence.has(evidenceId)) {
        caseRefsByEvidence.set(evidenceId, []);
      }
      caseRefsByEvidence.get(evidenceId).push(record.case_id);
    }
  }

  return reconcileSourceRecords({
    targetLayer: "case",
    sourceRecordType: "evidence",
    sourceRecords: evidenceRecords,
    store,
    reconciledAt,
    dryRun,
    evaluate(record) {
      const related = [...new Set(caseRefsByEvidence.get(record.evidence_id) ?? [])].sort();
      if (related.length > 0) {
        return {
          outcome: "promoted",
          rationale: "This evidence is already referenced by at least one canonical case series.",
          relatedRecordRefs: related,
        };
      }
      return {
        outcome: "blocked",
        rationale: "No canonical case series currently references this evidence under the case distillation contract.",
        relatedRecordRefs: [],
      };
    },
    getRecordId(record) {
      return record.evidence_id;
    },
  });
}

function reconcileCaseToInvariantPool({ catalog, store, reconciledAt, dryRun }) {
  const activeCases = catalog.listRecords("case").filter((record) => record.status === "active");
  const activeInvariants = catalog.listRecords("invariant").filter((record) => record.status === "active");
  const invariantRefsByCase = new Map();

  for (const invariant of activeInvariants) {
    for (const caseId of invariant.source_case_refs ?? []) {
      if (!invariantRefsByCase.has(caseId)) {
        invariantRefsByCase.set(caseId, []);
      }
      invariantRefsByCase.get(caseId).push(invariant.id);
    }
  }

  return reconcileSourceRecords({
    targetLayer: "invariant",
    sourceRecordType: "case",
    sourceRecords: activeCases,
    store,
    reconciledAt,
    dryRun,
    evaluate(record) {
      const related = [...new Set(invariantRefsByCase.get(record.case_id) ?? [])].sort();
      if (related.length > 0) {
        return {
          outcome: "covered",
          rationale: "This active case is already covered by at least one active invariant.",
          relatedRecordRefs: related,
        };
      }
      return {
        outcome: "blocked",
        rationale: "No autonomous invariant candidate currently covers this active case under the governed discovery surface.",
        relatedRecordRefs: [],
      };
    },
    getRecordId(record) {
      return record.case_id;
    },
  });
}

function reconcileInvariantToTacticPool({ catalog, store, reconciledAt, dryRun }) {
  const activeInvariants = catalog.listRecords("invariant").filter((record) => record.status === "active");
  const activeTactics = catalog.listRecords("tactic").filter((record) => record.status === "active");
  const tacticRefsByInvariant = new Map();

  for (const tactic of activeTactics) {
    for (const invariantId of tactic.supporting_invariant_refs ?? []) {
      if (!tacticRefsByInvariant.has(invariantId)) {
        tacticRefsByInvariant.set(invariantId, []);
      }
      tacticRefsByInvariant.get(invariantId).push(tactic.id);
    }
  }

  return reconcileSourceRecords({
    targetLayer: "tactic",
    sourceRecordType: "invariant",
    sourceRecords: activeInvariants,
    store,
    reconciledAt,
    dryRun,
    evaluate(record) {
      const related = [...new Set(tacticRefsByInvariant.get(record.id) ?? [])].sort();
      if (related.length > 0) {
        return {
          outcome: "covered",
          rationale: "This active invariant is already covered by at least one active tactic.",
          relatedRecordRefs: related,
        };
      }
      return {
        outcome: "blocked",
        rationale: "No autonomous tactic candidate currently covers this active invariant under the governed discovery surface.",
        relatedRecordRefs: [],
      };
    },
    getRecordId(record) {
      return record.id;
    },
  });
}

function reconcileSourceRecords({
  targetLayer,
  sourceRecordType,
  sourceRecords,
  store,
  reconciledAt,
  dryRun,
  evaluate,
  getRecordId,
}) {
  const written = [];
  const unchanged = [];

  for (const record of sourceRecords) {
    const sourceRecordId = getRecordId(record);
    const snapshotHash = createRecordSnapshotHash(record);
    const decision = evaluate(record);
    const packet = {
      reconciliation_id: createReconciliationId({
        targetLayer,
        sourceRecordType,
        sourceRecordId,
      }),
      target_layer: targetLayer,
      source_record_type: sourceRecordType,
      source_record_id: sourceRecordId,
      source_snapshot_hash: snapshotHash,
      source_status: record.status ?? null,
      outcome: decision.outcome,
      rationale: decision.rationale,
      related_record_refs: decision.relatedRecordRefs,
      reconciled_at: reconciledAt,
    };

    const existing = store.getPacket(targetLayer, sourceRecordType, sourceRecordId);
    if (
      existing &&
      existing.source_snapshot_hash === packet.source_snapshot_hash &&
      existing.outcome === packet.outcome &&
      JSON.stringify(existing.related_record_refs ?? []) === JSON.stringify(packet.related_record_refs ?? []) &&
      existing.rationale === packet.rationale
    ) {
      unchanged.push(sourceRecordId);
      continue;
    }

    if (!dryRun) {
      store.writePacket(packet, { overwrite: true });
    }

    written.push({
      source_record_id: sourceRecordId,
      outcome: packet.outcome,
      related_record_refs: packet.related_record_refs,
    });
  }

  return {
    total_records: sourceRecords.length,
    written_count: written.length,
    unchanged_count: unchanged.length,
    written,
  };
}

function createRecordSnapshotHash(record) {
  return `sha256:${crypto.createHash("sha256").update(JSON.stringify(record)).digest("hex")}`;
}

function createReconciliationId({ targetLayer, sourceRecordType, sourceRecordId }) {
  const digest = crypto
    .createHash("sha1")
    .update(`${targetLayer}:${sourceRecordType}:${sourceRecordId}`)
    .digest("hex")
    .slice(0, 16);

  return `reconcile_${targetLayer}_${sourceRecordType}_${digest}`;
}

module.exports = {
  reconcileEvidenceToCasePool,
  reconcileCaseToInvariantPool,
  reconcileInvariantToTacticPool,
  reconcileOpenPools,
};
