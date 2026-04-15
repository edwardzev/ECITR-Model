const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { FileBackedCatalog } = require("../src/storage/file-backed-catalog");
const { RetrievalRuntime } = require("../src/retrieval/runtime");
const {
  captureConversationSnapshot,
  buildConversationEvidenceId,
} = require("../src/evidence/conversation-snapshot");

test("conversation snapshot writes chat evidence and payload into the catalog", async () => {
  const catalogRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-conversation-"));
  const capturedAt = "2026-04-11T10:45:00.000Z";
  const result = captureConversationSnapshot({
    catalogRoot,
    conversationKey: "audit_memory_sytem",
    capturedAt,
    messages: [
      { role: "user", text: "Store this exact conversation." },
      { role: "assistant", text: "I will capture it as chat evidence." },
    ],
  });

  assert.equal(result.status, "captured");
  assert.equal(result.record.source_type, "chat");
  assert.equal(result.record.actor_scope, "mixed");
  assert.equal(
    result.record.evidence_id,
    buildConversationEvidenceId({ conversationKey: "audit_memory_sytem", capturedAt }),
  );

  const payload = JSON.parse(fs.readFileSync(result.payload_file, "utf8"));
  assert.equal(payload.capture_kind, "conversation_snapshot");
  assert.equal(payload.messages.length, 2);
  assert.equal(payload.messages[0].text, "Store this exact conversation.");
});

test("conversation snapshot links to the previous snapshot for the same conversation", async () => {
  const catalogRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-conversation-parent-"));
  const first = captureConversationSnapshot({
    catalogRoot,
    conversationKey: "audit_memory_sytem",
    capturedAt: "2026-04-11T10:45:00.000Z",
    messages: [{ role: "user", text: "First message." }],
  });

  const second = captureConversationSnapshot({
    catalogRoot,
    conversationKey: "audit_memory_sytem",
    capturedAt: "2026-04-11T10:46:00.000Z",
    messages: [
      { role: "user", text: "First message." },
      { role: "assistant", text: "Second snapshot." },
    ],
  });

  assert.equal(second.record.parent_evidence_id, first.record.evidence_id);
});

test("conversation snapshot evidence is retrievable by transcript text", async () => {
  const catalogRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-conversation-retrieval-"));
  captureConversationSnapshot({
    catalogRoot,
    conversationKey: "audit_memory_sytem",
    capturedAt: "2026-04-11T10:47:00.000Z",
    messages: [
      { role: "user", text: "Every symbol must end up in the evidence corpus." },
      { role: "assistant", text: "I am capturing this thread natively in ECITR." },
    ],
  });

  const catalog = new FileBackedCatalog({ rootDir: catalogRoot });
  const runtime = new RetrievalRuntime();
  const { response } = await runtime.execute({
    request: {
      request_id: "req_conversation_retrieval_001",
      query: "every symbol evidence corpus",
      project_scope: "project",
      intent: "analysis",
      allowed_layers: ["evidence"],
      max_results_per_layer: { evidence: 5 },
    },
    catalogs: catalog.loadRuntimeCatalogs(),
    now: new Date("2026-05-01T00:00:00Z"),
  });

  assert.equal(response.results.evidence.length, 1);
  assert.match(response.results.evidence[0], /^ev_chat_/);
});
