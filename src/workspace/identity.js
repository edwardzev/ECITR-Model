const WORKSPACE_ID_PATTERN = "^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$";
const MIXED_WORKSPACE_ID = "mixed";

function normalizeWorkspaceId(value) {
  if (value == null || value === "") {
    return null;
  }

  const normalized = String(value).trim();
  return normalized || null;
}

function hasWorkspaceConflict({ requestWorkspaceId, recordWorkspaceId }) {
  const requested = normalizeWorkspaceId(requestWorkspaceId);
  if (!requested) {
    return false;
  }

  return normalizeWorkspaceId(recordWorkspaceId) !== requested;
}

function mergeWorkspaceIds(...workspaceIds) {
  const normalized = [...new Set(workspaceIds.map(normalizeWorkspaceId).filter(Boolean))];
  if (normalized.length === 0) {
    return null;
  }

  return normalized.length === 1 ? normalized[0] : MIXED_WORKSPACE_ID;
}

function getRecordWorkspaceId(layer, record) {
  switch (layer) {
    case "tactics":
    case "invariants":
      return record.workspace_id ?? null;
    case "cases":
      return record.workspace_id ?? null;
    case "evidence":
      return record.workspace_id ?? null;
    default:
      throw new Error(`Unsupported layer for workspace resolution: ${layer}`);
  }
}

module.exports = {
  MIXED_WORKSPACE_ID,
  WORKSPACE_ID_PATTERN,
  getRecordWorkspaceId,
  hasWorkspaceConflict,
  mergeWorkspaceIds,
  normalizeWorkspaceId,
};
