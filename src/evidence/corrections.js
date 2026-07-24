function buildEvidenceCorrectionIndex(records = []) {
  const byId = new Map();
  const childByParent = new Map();

  for (const record of records) {
    if (!record?.evidence_id) {
      continue;
    }
    byId.set(record.evidence_id, record);
  }

  for (const record of byId.values()) {
    if (!record.correction_of) {
      continue;
    }
    if (!byId.has(record.correction_of)) {
      throw new Error(
        `Evidence correction ${record.evidence_id} references missing evidence ${record.correction_of}.`,
      );
    }
    const existingChild = childByParent.get(record.correction_of);
    if (existingChild && existingChild !== record.evidence_id) {
      throw new Error(
        `Evidence ${record.correction_of} has ambiguous corrections: ${existingChild}, ${record.evidence_id}.`,
      );
    }
    childByParent.set(record.correction_of, record.evidence_id);
  }

  for (const evidenceId of byId.keys()) {
    resolveLatestEvidenceCorrection({ byId, childByParent }, evidenceId);
  }

  return { byId, childByParent };
}

function resolveLatestEvidenceCorrection(index, evidenceId) {
  if (!index?.byId?.has(evidenceId)) {
    return null;
  }

  const seen = new Set();
  let currentId = evidenceId;
  while (index.childByParent.has(currentId)) {
    if (seen.has(currentId)) {
      throw new Error(`Evidence correction cycle detected at ${currentId}.`);
    }
    seen.add(currentId);
    currentId = index.childByParent.get(currentId);
  }
  return index.byId.get(currentId) ?? null;
}

function getCurrentEvidenceRecords(records = []) {
  const index = buildEvidenceCorrectionIndex(records);
  return records.filter((record) => !index.childByParent.has(record.evidence_id));
}

function compareExpectedEvidenceToCurrent({ index, expectedRecord, diffEvidenceRecords }) {
  const currentRecord = resolveLatestEvidenceCorrection(index, expectedRecord.evidence_id);
  if (!currentRecord) {
    return null;
  }

  const comparableExpected = {
    ...expectedRecord,
    evidence_id: currentRecord.evidence_id,
  };
  if (currentRecord.correction_of) {
    comparableExpected.correction_of = currentRecord.correction_of;
  }

  return {
    comparableExpected,
    currentRecord,
    mismatches: diffEvidenceRecords(currentRecord, comparableExpected),
  };
}

function withCurrentEvidenceRecords(catalogs) {
  const current = {
    ...catalogs,
    evidence: getCurrentEvidenceRecords(catalogs?.evidence ?? []),
  };
  if (catalogs?.__catalogRoot) {
    Object.defineProperty(current, "__catalogRoot", {
      value: catalogs.__catalogRoot,
      enumerable: false,
      configurable: false,
      writable: false,
    });
  }
  return current;
}

module.exports = {
  buildEvidenceCorrectionIndex,
  compareExpectedEvidenceToCurrent,
  getCurrentEvidenceRecords,
  resolveLatestEvidenceCorrection,
  withCurrentEvidenceRecords,
};
