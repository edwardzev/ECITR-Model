const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { FileBackedCatalog } = require("../src/storage/file-backed-catalog");
const { importCodexRollouts, isEquivalentLegacyCodexSnapshot } = require("../src/importers/codex-rollouts");

test("codex rollout import writes printed conversation evidence into the catalog", () => {
  const codexRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-codex-root-"));
  const catalogRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-codex-catalog-"));
  writeSessionIndex(codexRoot, [
    {
      id: "019d7ba6-0ee8-7c11-9063-ab3520bc8c93",
      thread_name: "Audit memory sytem",
      updated_at: "2026-04-11T10:53:47.131Z",
    },
  ]);
  writeRollout(
    codexRoot,
    "sessions/2026/04/11/rollout-2026-04-11T11-26-13-019d7ba6-0ee8-7c11-9063-ab3520bc8c93.jsonl",
    [
      sessionMeta({
        id: "019d7ba6-0ee8-7c11-9063-ab3520bc8c93",
        timestamp: "2026-04-11T08:26:13.619Z",
        cwd: "/Users/edwardzev/ECITR-Model",
      }),
      userMessage("2026-04-11T08:27:41.761Z", "Capture all Codex conversations."),
      agentMessage("2026-04-11T08:28:01.697Z", "I am importing the rollout stream.", "commentary"),
      agentMessage("2026-04-11T08:28:40.000Z", "Final answer text.", "final_answer"),
    ],
  );

  const summary = importCodexRollouts({
    codexRoot,
    catalogRoot,
    dryRun: false,
  });

  assert.equal(summary.imported, 1);
  const catalog = new FileBackedCatalog({ rootDir: catalogRoot });
  const records = catalog.listRecords("evidence");
  assert.equal(records.length, 1);
  assert.equal(records[0].source_type, "chat");
  assert.equal(records[0].source_locator, "codex-thread://019d7ba6-0ee8-7c11-9063-ab3520bc8c93");

  const payloadPath = path.join(catalogRoot, records[0].verbatim_payload_ref);
  const payload = JSON.parse(fs.readFileSync(payloadPath, "utf8"));
  assert.equal(payload.thread_name, "Audit memory sytem");
  assert.equal(payload.messages.length, 3);
  assert.equal(payload.messages[0].role, "user");
  assert.equal(payload.messages[2].phase, "final_answer");
  assert.equal(payload.checkpoint_reason, "first_seen");
});

test("codex rollout import skips unchanged rollout files with the import-state fingerprint check", () => {
  const codexRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-codex-unchanged-"));
  const catalogRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-codex-unchanged-catalog-"));
  writeSessionIndex(codexRoot, [
    {
      id: "thread_unchanged",
      thread_name: "Unchanged thread",
      updated_at: "2026-04-11T10:00:00.000Z",
    },
  ]);
  writeRollout(
    codexRoot,
    "sessions/2026/04/11/rollout-2026-04-11T10-00-00-thread_unchanged.jsonl",
    [
      sessionMeta({
        id: "thread_unchanged",
        timestamp: "2026-04-11T09:59:00.000Z",
        cwd: "/Users/edwardzev/ECITR-Model",
      }),
      userMessage("2026-04-11T10:00:00.000Z", "Original user message."),
      agentMessage("2026-04-11T10:00:05.000Z", "Original final answer.", "final_answer"),
    ],
    "2026-04-11T10:00:05.000Z",
  );

  const first = importCodexRollouts({
    codexRoot,
    catalogRoot,
    dryRun: false,
  });
  assert.equal(first.imported, 1);

  const second = importCodexRollouts({
    codexRoot,
    catalogRoot,
    dryRun: false,
  });
  assert.equal(second.imported, 0);
  assert.equal(second.skipped_unchanged, 1);
});

test("codex rollout import appends a later snapshot when a new final answer appears and links parent evidence", () => {
  const codexRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-codex-chain-"));
  const catalogRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-codex-chain-catalog-"));
  writeSessionIndex(codexRoot, [
    {
      id: "thread_001",
      thread_name: "Thread one",
      updated_at: "2026-04-11T10:00:00.000Z",
    },
  ]);
  const rolloutPath = "sessions/2026/04/11/rollout-2026-04-11T10-00-00-thread_001.jsonl";

  writeRollout(codexRoot, rolloutPath, [
    sessionMeta({
      id: "thread_001",
      timestamp: "2026-04-11T09:59:00.000Z",
      cwd: "/Users/edwardzev/ECITR-Model",
    }),
    userMessage("2026-04-11T10:00:00.000Z", "First user message."),
    agentMessage("2026-04-11T10:00:05.000Z", "First assistant message.", "final_answer"),
  ]);

  const first = importCodexRollouts({
    codexRoot,
    catalogRoot,
    dryRun: false,
  });
  assert.equal(first.imported, 1);

  writeRollout(codexRoot, rolloutPath, [
    sessionMeta({
      id: "thread_001",
      timestamp: "2026-04-11T09:59:00.000Z",
      cwd: "/Users/edwardzev/ECITR-Model",
    }),
    userMessage("2026-04-11T10:00:00.000Z", "First user message."),
    agentMessage("2026-04-11T10:00:05.000Z", "First assistant message.", "final_answer"),
    userMessage("2026-04-11T10:05:00.000Z", "Second user message."),
    agentMessage("2026-04-11T10:05:20.000Z", "Second assistant message.", "final_answer"),
  ], "2026-04-11T10:05:20.000Z");

  const second = importCodexRollouts({
    codexRoot,
    catalogRoot,
    dryRun: false,
  });
  assert.equal(second.imported, 1);

  const catalog = new FileBackedCatalog({ rootDir: catalogRoot });
  const records = catalog
    .listRecords("evidence")
    .filter((record) => record.source_locator === "codex-thread://thread_001")
    .sort((left, right) => new Date(left.captured_at).getTime() - new Date(right.captured_at).getTime());
  assert.equal(records.length, 2);
  assert.equal(records[1].parent_evidence_id, records[0].evidence_id);
});

test("codex rollout import skips changed threads that stay below the checkpoint thresholds", () => {
  const codexRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-codex-checkpoint-"));
  const catalogRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-codex-checkpoint-catalog-"));
  writeSessionIndex(codexRoot, [
    {
      id: "thread_checkpoint",
      thread_name: "Checkpoint thread",
      updated_at: "2026-04-11T10:00:00.000Z",
    },
  ]);
  const rolloutPath = "sessions/2026/04/11/rollout-2026-04-11T10-00-00-thread_checkpoint.jsonl";
  writeRollout(codexRoot, rolloutPath, [
    sessionMeta({
      id: "thread_checkpoint",
      timestamp: "2026-04-11T09:59:00.000Z",
      cwd: "/Users/edwardzev/ECITR-Model",
    }),
    userMessage("2026-04-11T10:00:00.000Z", "One user line."),
    agentMessage("2026-04-11T10:00:05.000Z", "One assistant line.", "final_answer"),
  ], "2026-04-11T10:00:05.000Z");

  const first = importCodexRollouts({
    codexRoot,
    catalogRoot,
    dryRun: false,
  });
  assert.equal(first.imported, 1);

  writeRollout(codexRoot, rolloutPath, [
    sessionMeta({
      id: "thread_checkpoint",
      timestamp: "2026-04-11T09:59:00.000Z",
      cwd: "/Users/edwardzev/ECITR-Model",
    }),
    userMessage("2026-04-11T10:00:00.000Z", "One user line."),
    agentMessage("2026-04-11T10:00:05.000Z", "One assistant line.", "final_answer"),
    userMessage("2026-04-12T10:00:00.000Z", "A small follow-up."),
    agentMessage("2026-04-12T10:00:05.000Z", "Commentary only.", "commentary"),
  ], "2026-04-12T10:00:05.000Z");

  const second = importCodexRollouts({
    codexRoot,
    catalogRoot,
    dryRun: false,
  });

  assert.equal(second.imported, 0);
  assert.equal(second.skipped_checkpoint, 1);
});

test("codex rollout import checkpoints a long-lived changed thread after seven days", () => {
  const codexRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-codex-age-"));
  const catalogRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-codex-age-catalog-"));
  writeSessionIndex(codexRoot, [
    {
      id: "thread_age",
      thread_name: "Age thread",
      updated_at: "2026-04-11T10:00:00.000Z",
    },
  ]);
  const rolloutPath = "sessions/2026/04/11/rollout-2026-04-11T10-00-00-thread_age.jsonl";
  writeRollout(codexRoot, rolloutPath, [
    sessionMeta({
      id: "thread_age",
      timestamp: "2026-04-11T09:59:00.000Z",
      cwd: "/Users/edwardzev/ECITR-Model",
    }),
    userMessage("2026-04-11T10:00:00.000Z", "Starting point."),
    agentMessage("2026-04-11T10:00:05.000Z", "Initial final answer.", "final_answer"),
  ], "2026-04-11T10:00:05.000Z");

  importCodexRollouts({
    codexRoot,
    catalogRoot,
    dryRun: false,
  });

  writeRollout(codexRoot, rolloutPath, [
    sessionMeta({
      id: "thread_age",
      timestamp: "2026-04-11T09:59:00.000Z",
      cwd: "/Users/edwardzev/ECITR-Model",
    }),
    userMessage("2026-04-11T10:00:00.000Z", "Starting point."),
    agentMessage("2026-04-11T10:00:05.000Z", "Initial final answer.", "final_answer"),
    userMessage("2026-04-19T10:00:00.000Z", "Still evolving."),
    agentMessage("2026-04-19T10:00:05.000Z", "Commentary only after eight days.", "commentary"),
  ], "2026-04-19T10:00:05.000Z");

  const summary = importCodexRollouts({
    codexRoot,
    catalogRoot,
    dryRun: false,
  });

  assert.equal(summary.imported, 1);
  const catalog = new FileBackedCatalog({ rootDir: catalogRoot });
  const records = catalog.listRecords("evidence").filter((record) => record.source_locator === "codex-thread://thread_age");
  assert.equal(records.length, 2);
});

test("codex rollout import checkpoints a changed thread after one hundred new messages", () => {
  const codexRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-codex-message-threshold-"));
  const catalogRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-codex-message-threshold-catalog-"));
  writeSessionIndex(codexRoot, [
    {
      id: "thread_messages",
      thread_name: "Message threshold thread",
      updated_at: "2026-04-11T10:00:00.000Z",
    },
  ]);
  const rolloutPath = "sessions/2026/04/11/rollout-2026-04-11T10-00-00-thread_messages.jsonl";
  writeRollout(codexRoot, rolloutPath, [
    sessionMeta({
      id: "thread_messages",
      timestamp: "2026-04-11T09:59:00.000Z",
      cwd: "/Users/edwardzev/ECITR-Model",
    }),
    userMessage("2026-04-11T10:00:00.000Z", "Starting point."),
    agentMessage("2026-04-11T10:00:05.000Z", "Initial final answer.", "final_answer"),
  ], "2026-04-11T10:00:05.000Z");

  importCodexRollouts({
    codexRoot,
    catalogRoot,
    dryRun: false,
  });

  const events = [
    sessionMeta({
      id: "thread_messages",
      timestamp: "2026-04-11T09:59:00.000Z",
      cwd: "/Users/edwardzev/ECITR-Model",
    }),
    userMessage("2026-04-11T10:00:00.000Z", "Starting point."),
    agentMessage("2026-04-11T10:00:05.000Z", "Initial final answer.", "final_answer"),
  ];
  for (let index = 0; index < 100; index += 1) {
    events.push(userMessage(`2026-04-12T10:${String(index % 60).padStart(2, "0")}:00.000Z`, `User line ${index + 1}.`));
  }
  writeRollout(codexRoot, rolloutPath, events, "2026-04-12T11:59:59.000Z");

  const summary = importCodexRollouts({
    codexRoot,
    catalogRoot,
    dryRun: false,
  });

  assert.equal(summary.imported, 1);
});

test("codex rollout import writes an archive checkpoint even when no new message was printed", () => {
  const codexRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-codex-archive-"));
  const catalogRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-codex-archive-catalog-"));
  writeSessionIndex(codexRoot, [
    {
      id: "thread_archive",
      thread_name: "Archive thread",
      updated_at: "2026-04-11T10:00:00.000Z",
    },
  ]);
  const activeEvents = [
    sessionMeta({
      id: "thread_archive",
      timestamp: "2026-04-11T09:59:00.000Z",
      cwd: "/Users/edwardzev/ECITR-Model",
    }),
    userMessage("2026-04-11T10:00:00.000Z", "One user line."),
    agentMessage("2026-04-11T10:00:05.000Z", "One assistant line.", "final_answer"),
  ];
  writeRollout(codexRoot, "sessions/2026/04/11/rollout-2026-04-11T10-00-00-thread_archive.jsonl", activeEvents, "2026-04-11T10:00:05.000Z");

  importCodexRollouts({
    codexRoot,
    catalogRoot,
    dryRun: false,
  });

  writeRollout(codexRoot, "archived_sessions/rollout-2026-04-11T10-00-00-thread_archive.jsonl", activeEvents, "2026-04-12T06:00:00.000Z");

  const summary = importCodexRollouts({
    codexRoot,
    catalogRoot,
    dryRun: false,
  });

  assert.equal(summary.imported, 1);
  const catalog = new FileBackedCatalog({ rootDir: catalogRoot });
  const records = catalog
    .listRecords("evidence")
    .filter((record) => record.source_locator === "codex-thread://thread_archive")
    .sort((left, right) => new Date(left.captured_at).getTime() - new Date(right.captured_at).getTime());
  assert.equal(records.length, 2);
  assert.equal(records[1].parent_evidence_id, records[0].evidence_id);
  const payloadPath = path.join(catalogRoot, records[1].verbatim_payload_ref);
  const payload = JSON.parse(fs.readFileSync(payloadPath, "utf8"));
  assert.equal(payload.archived, true);
  assert.equal(payload.checkpoint_reason, "thread_archived");
});

test("legacy-equivalent Codex snapshots are treated as the same canonical source state", () => {
  const existing = {
    evidence_id: "ev_codex_thread_thread_legacy_20260411_100005000Z",
    substrate_ref: "file:///tmp/thread_legacy.jsonl",
    source_type: "chat",
    source_locator: "codex-thread://thread_legacy",
    captured_at: "2026-04-11T10:00:05.000Z",
    project_scope: "project",
    actor_scope: "mixed",
    verbatim_payload_ref: "payloads/evidence/codex/rollouts/2026/04/legacy.json",
    payload_hash: "sha256:legacy",
    source_hash: "sha256:source",
    redaction_state: "none",
    immutable: true,
  };
  const next = {
    ...existing,
    payload_hash: "sha256:new-shape",
    parent_evidence_id: "ev_codex_thread_thread_legacy_20260410_100005000Z",
  };

  assert.equal(isEquivalentLegacyCodexSnapshot(existing, next), true);
});

function writeSessionIndex(codexRoot, entries) {
  const filePath = path.join(codexRoot, "session_index.jsonl");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
}

function writeRollout(codexRoot, relativePath, events, mtime = null) {
  const filePath = path.join(codexRoot, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
  if (mtime) {
    const time = new Date(mtime);
    fs.utimesSync(filePath, time, time);
  }
}

function sessionMeta({ id, timestamp, cwd }) {
  return {
    timestamp,
    type: "session_meta",
    payload: {
      id,
      timestamp,
      cwd,
      originator: "Codex Desktop",
      cli_version: "0.119.0",
      source: "vscode",
      model_provider: "openai",
    },
  };
}

function userMessage(timestamp, message) {
  return {
    timestamp,
    type: "event_msg",
    payload: {
      type: "user_message",
      message,
      images: [],
      local_images: [],
      text_elements: [],
    },
  };
}

function agentMessage(timestamp, message, phase) {
  return {
    timestamp,
    type: "event_msg",
    payload: {
      type: "agent_message",
      message,
      phase,
      memory_citation: null,
    },
  };
}
