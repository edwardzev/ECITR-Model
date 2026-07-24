const path = require("node:path");

const { FilePayloadStore, createSha256 } = require("./file-payload-store");
const { assertLifecycleRecord } = require("../lifecycle/rules");
const { FileBackedCatalog } = require("../storage/file-backed-catalog");
const { EcitrValidator } = require("../validation/validator");
const { resolveWorkspaceId } = require("../workspace/config");

const PAYLOAD_NAMESPACE_SEGMENTS = Object.freeze(["ecitr", "conversations"]);
const SOURCE_LOCATOR_PREFIX = "codex-thread://";
const SUBSTRATE_REF_PREFIX = "ecitr-chat://conversation/";
const MESSAGE_ROLES = new Set(["user", "assistant", "system"]);

function captureConversationSnapshot({
  catalogRoot,
  conversationKey,
  messages,
  capturedAt = new Date().toISOString(),
  projectScope = "project",
  workspaceId = resolveWorkspaceId({ catalogRoot }),
  sourceLocator = null,
  redactionState = "none",
  validator = new EcitrValidator(),
} = {}) {
  if (!catalogRoot) {
    throw new Error("captureConversationSnapshot requires a catalogRoot.");
  }

  const normalizedConversationKey = normalizeConversationKey(conversationKey);
  const normalizedMessages = normalizeMessages(messages);
  const resolvedCatalogRoot = path.resolve(catalogRoot);
  const catalog = new FileBackedCatalog({
    rootDir: resolvedCatalogRoot,
    validator,
  });
  const payloadStore = new FilePayloadStore({ rootDir: resolvedCatalogRoot });
  const evidenceId = buildConversationEvidenceId({
    conversationKey: normalizedConversationKey,
    capturedAt,
  });
  const payload = buildConversationPayload({
    conversationKey: normalizedConversationKey,
    capturedAt,
    messages: normalizedMessages,
  });
  const payloadBytes = `${JSON.stringify(payload, null, 2)}\n`;
  const payloadPlan = payloadStore.planPayload({
    evidenceId,
    capturedAt,
    extension: ".json",
    namespaceSegments: PAYLOAD_NAMESPACE_SEGMENTS,
    bytes: payloadBytes,
  });
  const resolvedSourceLocator = sourceLocator || `${SOURCE_LOCATOR_PREFIX}${normalizedConversationKey}`;
  const existingParent = findLatestConversationSnapshot({
    catalog,
    sourceLocator: resolvedSourceLocator,
  });
  const record = {
    evidence_id: evidenceId,
    ...(workspaceId ? { workspace_id: workspaceId } : {}),
    substrate_ref: `${SUBSTRATE_REF_PREFIX}${normalizedConversationKey}/snapshot/${evidenceId}`,
    source_type: "chat",
    source_locator: resolvedSourceLocator,
    captured_at: capturedAt,
    project_scope: projectScope,
    actor_scope: inferActorScope(normalizedMessages),
    verbatim_payload_ref: payloadPlan.relativeRef,
    payload_hash: payloadPlan.payloadHash,
    source_hash: createSha256(payloadBytes),
    redaction_state: redactionState,
    immutable: true,
  };

  if (existingParent) {
    record.parent_evidence_id = existingParent.evidence_id;
  }

  validator.validateRecord("evidence", record);
  assertLifecycleRecord("evidence", record);

  const existingRecord = catalog.getRecord("evidence", evidenceId);
  if (existingRecord) {
    const mismatches = diffEvidenceRecords(existingRecord, record);
    if (mismatches.length === 0) {
      return {
        status: "skipped_existing",
        record,
      };
    }

    return {
      status: "conflict",
      record,
      mismatches,
    };
  }

  payloadStore.writePayload({
    evidenceId,
    capturedAt,
    extension: ".json",
    namespaceSegments: PAYLOAD_NAMESPACE_SEGMENTS,
    bytes: payloadBytes,
  });
  const persisted = catalog.writeRecord("evidence", record);

  return {
    status: "captured",
    record,
    record_file: persisted.filePath,
    payload_file: payloadPlan.absolutePath,
  };
}

function buildConversationPayload({ conversationKey, capturedAt, messages }) {
  return {
    capture_kind: "conversation_snapshot",
    conversation_key: conversationKey,
    captured_at: capturedAt,
    message_count: messages.length,
    messages: messages.map((message, index) => ({
      sequence: index + 1,
      role: message.role,
      text: message.text,
    })),
  };
}

function buildConversationEvidenceId({ conversationKey, capturedAt }) {
  const timestamp = new Date(capturedAt);
  if (Number.isNaN(timestamp.getTime())) {
    throw new Error(`Conversation snapshot capturedAt must be valid ISO-8601: ${capturedAt}`);
  }

  const compactTimestamp = timestamp.toISOString().replace(/[-:.]/g, "").replace("T", "_").replace("Z", "Z");
  return `ev_chat_${conversationKey}_${compactTimestamp}`;
}

function normalizeConversationKey(value) {
  if (!value || typeof value !== "string") {
    throw new Error("Conversation snapshot requires a non-empty conversationKey.");
  }

  const normalized = value
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");

  if (!normalized) {
    throw new Error("Conversation snapshot conversationKey did not produce a safe identifier.");
  }

  return normalized;
}

function normalizeMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error("Conversation snapshot requires a non-empty messages array.");
  }

  return messages.map((message, index) => {
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      throw new Error(`Conversation message ${index + 1} must be an object.`);
    }

    if (!MESSAGE_ROLES.has(message.role)) {
      throw new Error(`Conversation message ${index + 1} has unsupported role: ${message.role}`);
    }

    if (typeof message.text !== "string") {
      throw new Error(`Conversation message ${index + 1} must contain a string text field.`);
    }

    return {
      role: message.role,
      text: message.text,
    };
  });
}

function inferActorScope(messages) {
  const roles = new Set(messages.map((message) => message.role));

  if (roles.has("user") && roles.has("assistant")) {
    return "mixed";
  }

  if (roles.has("user")) {
    return "human";
  }

  if (roles.has("assistant")) {
    return "agent";
  }

  return "system";
}

function findLatestConversationSnapshot({ catalog, sourceLocator }) {
  const matches = catalog
    .listRecords("evidence")
    .filter((record) => record.source_type === "chat" && record.source_locator === sourceLocator)
    .sort((left, right) => new Date(left.captured_at).getTime() - new Date(right.captured_at).getTime());

  return matches.at(-1) ?? null;
}

function diffEvidenceRecords(existingRecord, nextRecord) {
  const keys = [
    "evidence_id",
    "substrate_ref",
    "source_type",
    "source_locator",
    "captured_at",
    "project_scope",
    "actor_scope",
    "verbatim_payload_ref",
    "payload_hash",
    "source_hash",
    "parent_evidence_id",
    "correction_of",
    "redaction_state",
    "immutable",
  ];

  return keys.filter((key) => normalizeComparableValue(existingRecord[key]) !== normalizeComparableValue(nextRecord[key]));
}

function normalizeComparableValue(value) {
  return value ?? null;
}

module.exports = {
  PAYLOAD_NAMESPACE_SEGMENTS,
  SOURCE_LOCATOR_PREFIX,
  captureConversationSnapshot,
  buildConversationPayload,
  buildConversationEvidenceId,
  normalizeConversationKey,
};
