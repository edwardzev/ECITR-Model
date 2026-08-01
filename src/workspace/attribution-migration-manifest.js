const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const { EcitrValidator, readJson } = require("../validation/validator");

class WorkspaceAttributionMigrationManifestStore {
  constructor({ rootDir, validator = new EcitrValidator() } = {}) {
    if (!rootDir) {
      throw new Error("WorkspaceAttributionMigrationManifestStore requires a rootDir.");
    }

    this.rootDir = path.resolve(rootDir);
    this.validator = validator;
  }

  writeManifest(manifest, { overwrite = false } = {}) {
    this.validator.validateRecord("workspace_attribution_migration", manifest);
    const filePath = this.getManifestPath(manifest.migration_id);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });

    if (fs.existsSync(filePath) && !overwrite) {
      throw new Error(`Workspace attribution migration manifest already exists: ${manifest.migration_id}`);
    }

    fs.writeFileSync(filePath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    return {
      filePath,
      manifest: structuredClone(manifest),
    };
  }

  getManifest(migrationId) {
    const filePath = this.getManifestPath(migrationId);
    return fs.existsSync(filePath) ? readJson(filePath) : null;
  }

  getManifestPath(migrationId) {
    return path.join(
      this.rootDir,
      "state",
      "workspace-attribution-migrations",
      `${migrationId}.json`,
    );
  }
}

function createMigrationOperation({
  action,
  recordType,
  recordId,
  targetRecordId = recordId,
  filePath,
  sourceFilePath,
  targetWorkspaceId,
  beforeRecord,
  afterRecord,
}) {
  const beforeHash = hashRecord(beforeRecord);
  const afterHash = hashRecord(afterRecord);
  const operationId = `wao_${hashText(JSON.stringify({
    action,
    recordType,
    recordId,
    targetRecordId,
    beforeHash,
    afterHash,
  })).slice(0, 20)}`;

  return {
    operation_id: operationId,
    action,
    record_type: recordType,
    record_id: recordId,
    target_record_id: targetRecordId,
    ...(filePath ? { file_path: path.resolve(filePath) } : {}),
    ...(sourceFilePath ? { source_file_path: path.resolve(sourceFilePath) } : {}),
    from_workspace_id: beforeRecord.workspace_id ?? null,
    to_workspace_id: targetWorkspaceId,
    before_hash: beforeHash,
    after_hash: afterHash,
    before_record: structuredClone(beforeRecord),
    after_record: structuredClone(afterRecord),
  };
}

function createMigrationManifest({
  targetWorkspaceId,
  agentOpsProjectIds,
  codexWorkspaceRoots,
  operations,
  blockers,
  plannedAt,
  createdBy,
}) {
  const sortedOperations = [...operations].sort(compareOperations);
  const sortedBlockers = [...blockers].sort((left, right) =>
    `${left.record_type}:${left.record_id}:${left.code}`.localeCompare(
      `${right.record_type}:${right.record_id}:${right.code}`,
    ));
  const basisHash = hashRecord({
    targetWorkspaceId,
    operations: sortedOperations.map((operation) => ({
      operation_id: operation.operation_id,
      before_hash: operation.before_hash,
      after_hash: operation.after_hash,
    })),
    blockers: sortedBlockers,
  });
  const migrationId = `wam_${targetWorkspaceId}_${basisHash.slice("sha256:".length, "sha256:".length + 16)}`;

  return {
    migration_id: migrationId,
    schema_version: 1,
    status: "planned",
    target_workspace_id: targetWorkspaceId,
    source_selectors: {
      agent_ops_project_ids: [...new Set(agentOpsProjectIds)].sort(),
      codex_workspace_roots: [...new Set(codexWorkspaceRoots.map((entry) => path.resolve(entry)))].sort(),
    },
    basis_hash: basisHash,
    planned_at: plannedAt,
    created_by: createdBy,
    summary: {
      operation_count: sortedOperations.length,
      blocker_count: sortedBlockers.length,
      operation_counts: countOperations(sortedOperations),
    },
    operations: sortedOperations,
    blockers: sortedBlockers,
  };
}

function hashRecord(value) {
  return `sha256:${hashText(stableStringify(value))}`;
}

function hashText(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function stableStringify(value) {
  return JSON.stringify(sortJson(value));
}

function sortJson(value) {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortJson(value[key])]),
  );
}

function compareOperations(left, right) {
  const order = {
    evidence: 0,
    parameter_definition: 1,
    parameter_observation: 2,
    case: 3,
    invariant: 4,
    tactic: 5,
    case_seed: 6,
    case_compilation_packet: 7,
    invariant_promotion_packet: 8,
    tactic_promotion_packet: 9,
    live_invariant_candidate: 10,
    live_tactic_candidate: 11,
  };
  return (order[left.record_type] ?? 99) - (order[right.record_type] ?? 99)
    || left.target_record_id.localeCompare(right.target_record_id);
}

function countOperations(operations) {
  const counts = {};
  for (const operation of operations) {
    counts[operation.record_type] = (counts[operation.record_type] ?? 0) + 1;
  }
  return counts;
}

module.exports = {
  WorkspaceAttributionMigrationManifestStore,
  createMigrationManifest,
  createMigrationOperation,
  hashRecord,
};
