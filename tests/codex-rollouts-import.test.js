const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { FileBackedCatalog } = require("../src/storage/file-backed-catalog");
const { CaseSeedStore } = require("../src/cases/case-seed-store");
const { createSha256 } = require("../src/evidence/file-payload-store");
const { importCodexRollouts, parseCodexRollout, isEquivalentLegacyCodexSnapshot } = require("../src/importers/codex-rollouts");
const { PARSER_VERSION } = require("../src/importers/codex-visible-messages");

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

test("codex rollout import conflicts on workspace drift and remains idempotent within one workspace", () => {
  const codexRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-codex-workspace-identity-"));
  const catalogRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-codex-workspace-identity-catalog-"));
  const threadId = "thread_workspace_identity";
  writeSessionIndex(codexRoot, [{
    id: threadId,
    thread_name: "Workspace identity",
    updated_at: "2026-04-11T10:00:05.000Z",
  }]);
  writeRollout(
    codexRoot,
    `sessions/2026/04/11/rollout-2026-04-11T10-00-00-${threadId}.jsonl`,
    [
      sessionMeta({
        id: threadId,
        timestamp: "2026-04-11T09:59:00.000Z",
        cwd: "/Users/edwardzev/ECITR-Model",
      }),
      userMessage("2026-04-11T10:00:00.000Z", "Preserve workspace identity."),
      agentMessage("2026-04-11T10:00:05.000Z", "Final answer.", "final_answer"),
    ],
  );

  const first = importCodexRollouts({
    codexRoot,
    catalogRoot,
    workspaceId: "workspace_alpha",
    dryRun: false,
  });
  assert.equal(first.imported, 1);

  const catalog = new FileBackedCatalog({ rootDir: catalogRoot });
  const record = catalog.listRecords("evidence")[0];
  const payloadPath = path.join(catalogRoot, record.verbatim_payload_ref);
  const payload = JSON.parse(fs.readFileSync(payloadPath, "utf8"));
  payload.final_answer_count = 0;
  fs.writeFileSync(payloadPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  const statePath = path.join(catalogRoot, "state", "codex-rollouts.json");
  fs.rmSync(statePath, { force: true });

  const identical = importCodexRollouts({
    codexRoot,
    catalogRoot,
    workspaceId: "workspace_alpha",
    dryRun: false,
  });
  fs.rmSync(statePath, { force: true });
  const wrongWorkspace = importCodexRollouts({
    codexRoot,
    catalogRoot,
    workspaceId: "workspace_beta",
    dryRun: false,
  });

  assert.equal(identical.skipped_existing, 1, JSON.stringify(identical));
  assert.equal(identical.conflicts, 0);
  assert.equal(wrongWorkspace.skipped_existing, 0);
  assert.equal(wrongWorkspace.conflicts, 1);
  assert.ok(wrongWorkspace.conflict_details[0].conflict_fields.includes("workspace_id"));
});

test("codex rollout import can filter to the MSBC workspace and stamp the mapped workspace id", () => {
  const codexRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-codex-msbc-filter-"));
  const catalogRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-codex-msbc-filter-catalog-"));
  fs.writeFileSync(path.join(catalogRoot, "ecitr.project.json"), `${JSON.stringify({
    schema_version: 1,
    workspace_id: "ecitr_model",
    catalog_root: ".",
    default_project_scope: "project",
    preflight_retrieval_mandatory: false,
    failure_retry_retrieval_mandatory: false,
  }, null, 2)}\n`, "utf8");
  writeSessionIndex(codexRoot, [
    {
      id: "thread_msbc",
      thread_name: "MSBC thread",
      updated_at: "2026-04-11T10:00:00.000Z",
    },
    {
      id: "thread_other",
      thread_name: "Other thread",
      updated_at: "2026-04-11T10:01:00.000Z",
    },
  ]);
  writeRollout(
    codexRoot,
    "sessions/2026/04/11/rollout-2026-04-11T10-00-00-thread_msbc.jsonl",
    [
      sessionMeta({
        id: "thread_msbc",
        timestamp: "2026-04-11T09:59:00.000Z",
        cwd: "/Users/edwardzev/MS Business Central",
      }),
      userMessage("2026-04-11T10:00:00.000Z", "Invoice layout task."),
      agentMessage("2026-04-11T10:00:05.000Z", "Final answer.", "final_answer"),
    ],
  );
  writeRollout(
    codexRoot,
    "sessions/2026/04/11/rollout-2026-04-11T10-01-00-thread_other.jsonl",
    [
      sessionMeta({
        id: "thread_other",
        timestamp: "2026-04-11T10:00:00.000Z",
        cwd: "/Users/edwardzev/ECITR-Model",
      }),
      userMessage("2026-04-11T10:01:00.000Z", "Other repo task."),
      agentMessage("2026-04-11T10:01:05.000Z", "Other final answer.", "final_answer"),
    ],
  );

  const summary = importCodexRollouts({
    codexRoot,
    catalogRoot,
    workspaceRoot: "/Users/edwardzev/MS Business Central",
    dryRun: false,
  });

  assert.equal(summary.imported, 1);
  assert.equal(summary.skipped_workspace_filter, 1);
  const catalog = new FileBackedCatalog({ rootDir: catalogRoot });
  const records = catalog.listRecords("evidence");
  assert.equal(records.length, 1);
  assert.equal(records[0].workspace_id, "ms_business_central");
});

test("codex rollout import attaches chat evidence only to exact matching seed thread_ref", () => {
  const codexRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-codex-seed-link-"));
  const catalogRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-codex-seed-link-catalog-"));
  const seedStore = new CaseSeedStore({ rootDir: catalogRoot });
  const seedRun = {
    id: "run_chat_seed",
    project_id: "agent_ops",
    session_ref: "memory/sessions/2026/04/session_chat_seed.json",
    thread_ref: "codex-thread://thread_match",
    ecitr_closeout: candidateCloseout(),
    created_at: "2026-04-11T09:00:00.000Z",
  };

  const created = seedStore.upsertFromRun({
    runRef: "memory/runs/2026/04/run_chat_seed.json",
    runRecord: seedRun,
    runEvidenceRef: "ev_aops_run_run_chat_seed",
    workspaceId: "ecitr_model",
    sourceRunArtifactHash: createSha256(JSON.stringify(seedRun)),
    now: "2026-04-11T09:00:01.000Z",
  });
  const beforeSeed = seedStore.getSeed(created.seed.case_seed_id);

  writeSessionIndex(codexRoot, [
    {
      id: "thread_match",
      thread_name: "Matching thread",
      updated_at: "2026-04-11T10:00:00.000Z",
    },
    {
      id: "thread_other",
      thread_name: "Other thread",
      updated_at: "2026-04-11T10:01:00.000Z",
    },
  ]);
  writeRollout(
    codexRoot,
    "sessions/2026/04/11/rollout-2026-04-11T10-00-00-thread_match.jsonl",
    [
      sessionMeta({
        id: "thread_match",
        timestamp: "2026-04-11T09:59:00.000Z",
        cwd: "/Users/edwardzev/ECITR-Model",
      }),
      userMessage("2026-04-11T10:00:00.000Z", "Matching user message."),
      agentMessage("2026-04-11T10:00:05.000Z", "Matching final answer.", "final_answer"),
    ],
  );
  writeRollout(
    codexRoot,
    "sessions/2026/04/11/rollout-2026-04-11T10-01-00-thread_other.jsonl",
    [
      sessionMeta({
        id: "thread_other",
        timestamp: "2026-04-11T10:00:00.000Z",
        cwd: "/Users/edwardzev/ECITR-Model",
      }),
      userMessage("2026-04-11T10:01:00.000Z", "Other user message."),
      agentMessage("2026-04-11T10:01:05.000Z", "Other final answer.", "final_answer"),
    ],
  );

  const summary = importCodexRollouts({
    codexRoot,
    catalogRoot,
    workspaceId: "ecitr_model",
    dryRun: false,
  });

  assert.equal(summary.imported, 2);
  assert.equal(summary.case_seed_chat_links_attached, 1);

  const afterSeed = seedStore.getSeed(created.seed.case_seed_id);
  assert.deepEqual(afterSeed.seed_packet, beforeSeed.seed_packet);
  assert.equal(afterSeed.evidence_links.chat_evidence_refs.length, 1);

  const catalog = new FileBackedCatalog({ rootDir: catalogRoot });
  const chatEvidence = catalog.getRecord("evidence", afterSeed.evidence_links.chat_evidence_refs[0]);
  assert.equal(chatEvidence.source_locator, "codex-thread://thread_match");

  const second = importCodexRollouts({
    codexRoot,
    catalogRoot,
    workspaceId: "ecitr_model",
    dryRun: false,
  });
  assert.equal(second.skipped_unchanged, 2);
  assert.equal(seedStore.getSeed(created.seed.case_seed_id).evidence_links.chat_evidence_refs.length, 1);
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

test("legacy-equivalent Codex snapshots require the same visible bodies as well as the same canonical source state", () => {
  const existing = {
    evidence_id: "ev_codex_thread_thread_legacy_20260411_100005000Z",
    workspace_id: "workspace_alpha",
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

  const messages = [{ sequence: 1, timestamp: NEW_TIME, role: "user", phase: null, text: "Same exact body  " }];
  const matchingBodies = { existingMessages: messages, nextMessages: messages };
  assert.equal(isEquivalentLegacyCodexSnapshot(existing, next, matchingBodies), true);
  assert.equal(
    isEquivalentLegacyCodexSnapshot(existing, { ...next, workspace_id: "workspace_beta" }, matchingBodies),
    false,
  );
  assert.equal(isEquivalentLegacyCodexSnapshot(existing, next), false);
  assert.equal(isEquivalentLegacyCodexSnapshot(existing, next, { ...matchingBodies, nextMessages: [] }), false);
});

test("current printed events preserve Unicode, whitespace and native metadata without input copies or private reasoning", () => {
  const userText = "  שלום\nمرحبا\t🙂 e\u0301  ";
  const answer = "Exact printed answer.  \n";
  const citation = { citation_entries: [{ path: "MEMORY.md", start_line: 1, end_line: 2 }], rollout_ids: [] };
  const events = [
    newSession(),
    responseMessage("user", "Injected instructions", { kinds: ["agents_md.instructions"] }),
    responseMessage("user", userText),
    completedMessage("user", userText, { id: "ui-user" }),
    { type: "response_item", timestamp: NEW_TIME, payload: { type: "reasoning", summary: [{ text: "PRIVATE REASONING" }] } },
    { type: "event_msg", timestamp: NEW_TIME, payload: { type: "item_completed", item: { type: "McpToolCall", content: [{ type: "Text", text: "PRIVATE TOOL" }] } } },
    responseMessage("assistant", `${answer}<oai-mem-citation>hidden wrapper</oai-mem-citation>`, { id: "ui-answer" }),
    completedMessage("assistant", answer, { id: "ui-answer", memoryCitation: citation }),
    { type: "compacted", timestamp: NEW_TIME, payload: { replacement_history: [responseMessage("user", "REPLAYED INPUT")] } },
  ];
  const parsed = parseEvents(events);
  assert.equal(parsed.coverageStatus, "supported");
  assert.equal(parsed.format, "current_completed");
  assert.deepEqual(parsed.visibleMessages.map(({ role, text }) => ({ role, text })), [
    { role: "user", text: userText }, { role: "assistant", text: answer },
  ]);
  assert.equal(parsed.finalAnswerCount, 1);
  assert.equal(parsed.projectionCounts.excluded_context, 1);
  assert.equal(parsed.projectionCounts.response_projections, 2);
  assert.deepEqual(parsed.messageMetadata[1].memory_citation, citation);
  assert.equal(parsed.messageMetadata[1].native_message_id, "ui-answer");
  const fixture = newFixture(events);
  const summary = importCodexRollouts({ ...fixture, dryRun: false });
  assert.equal(summary.imported, 1);
  const record = new FileBackedCatalog({ rootDir: fixture.catalogRoot }).listRecords("evidence")[0];
  const payloadBytes = fs.readFileSync(path.join(fixture.catalogRoot, record.verbatim_payload_ref), "utf8");
  const payload = JSON.parse(payloadBytes);
  assert.equal(record.payload_hash, createSha256(payloadBytes));
  assert.equal(record.source_hash, createSha256(fs.readFileSync(fixture.sourcePath)));
  assert.equal(payload.capture_parser.version, PARSER_VERSION);
  assert.equal(payload.message_metadata[1].native_turn_id, "turn-new");
  for (const excluded of ["Injected instructions", "PRIVATE REASONING", "PRIVATE TOOL", "hidden wrapper", "REPLAYED INPUT"]) {
    assert.equal(payloadBytes.includes(excluded), false);
  }
});

test("current capture preserves repeated identical printed occurrences and only suppresses proven duplicate identities", () => {
  const events = [newSession()];
  for (const turn of ["turn-a", "turn-b", "turn-c"]) {
    events.push(responseMessage("user", "same text", { turn }), completedMessage("user", "same text", { turn, id: `user-${turn}` }));
  }
  const last = completedMessage("assistant", "Answer", { id: "answer" });
  events.push(last, last);
  const parsed = parseEvents(events);
  assert.equal(parsed.coverageStatus, "supported");
  assert.deepEqual(parsed.visibleMessages.map((message) => message.text), ["same text", "same text", "same text", "Answer"]);
  assert.deepEqual(parsed.visibleMessages.map((message) => message.sequence), [1, 2, 3, 4]);
  assert.equal(parsed.projectionCounts.duplicate_projections, 1);
  assert.equal(parsed.finalAnswerCount, 1);
  const conflicting = parseEvents([...events, completedMessage("assistant", "Different", { id: "answer" })]);
  assert.equal(conflicting.coverageStatus, "partial");
  assert.ok(conflicting.diagnostics.some((entry) => entry.code === "conflicting_completed_message_identity"));
});

test("older completed messages enrich final phase only from a byte-identical adjacent occurrence or shared identity", () => {
  const text = "  Exact final.\n";
  const completed = completedMessage("assistant", text, { id: null, phase: null });
  const parsed = parseEvents([newSession(), completed, responseMessage("assistant", text, { id: null, metadata: false })]);
  assert.equal(parsed.coverageStatus, "supported");
  assert.equal(parsed.finalAnswerCount, 1);
  assert.equal(parsed.visibleMessages[0].text, text);
  assert.equal(parsed.messageMetadata[0].phase_source_line, 3);
  const notExact = parseEvents([newSession(), completed, responseMessage("assistant", text.trim(), { id: null, metadata: false })]);
  assert.equal(notExact.coverageStatus, "partial");
  assert.equal(notExact.finalAnswerCount, 0);
  const notAdjacent = parseEvents([newSession(), completed, { type: "turn_context", payload: {} }, responseMessage("assistant", text, { id: null, metadata: false })]);
  assert.equal(notAdjacent.coverageStatus, "partial");
  assert.equal(notAdjacent.finalAnswerCount, 0);
});

test("current final phase enrichment drives checkpointed append without changing earlier payloads", () => {
  const firstEvents = [newSession(), completedMessage("assistant", "First", { id: null, phase: null }), responseMessage("assistant", "First", { metadata: false })];
  const fixture = newFixture(firstEvents);
  assert.equal(importCodexRollouts({ ...fixture, dryRun: false }).imported, 1);
  const oldRecord = new FileBackedCatalog({ rootDir: fixture.catalogRoot }).listRecords("evidence")[0];
  const oldBytes = fs.readFileSync(path.join(fixture.catalogRoot, oldRecord.verbatim_payload_ref));
  const later = "2026-09-13T11:00:00.000Z";
  writeRollout(fixture.codexRoot, fixture.relativePath, [...firstEvents,
    completedMessage("assistant", "Second", { id: null, phase: null, timestamp: later }),
    responseMessage("assistant", "Second", { metadata: false, timestamp: later }),
  ], later);
  const second = importCodexRollouts({ ...fixture, dryRun: false });
  assert.equal(second.imported, 1, JSON.stringify(second));
  const records = new FileBackedCatalog({ rootDir: fixture.catalogRoot }).listRecords("evidence");
  assert.equal(records.length, 2);
  assert.ok(records.some((record) => record.parent_evidence_id === oldRecord.evidence_id));
  assert.deepEqual(fs.readFileSync(path.join(fixture.catalogRoot, oldRecord.verbatim_payload_ref)), oldBytes);
});

test("mixed legacy and completed eras preserve order and require shared identities for cross-family dedup", () => {
  const legacy = userMessage("2026-09-13T09:00:00.000Z", "First era");
  legacy.payload.turn_id = "old-turn";
  const parsed = parseEvents([newSession(), legacy, completedMessage("user", "Next era", { turn: "new-turn" })]);
  assert.equal(parsed.format, "mixed");
  assert.equal(parsed.coverageStatus, "supported");
  assert.deepEqual(parsed.visibleMessages.map((message) => message.text), ["First era", "Next era"]);
  const duplicateLegacy = userMessage(NEW_TIME, "duplicate");
  duplicateLegacy.payload.turn_id = "turn-new";
  const ambiguous = parseEvents([newSession(), duplicateLegacy, completedMessage("user", "duplicate", { id: "shared" })]);
  assert.equal(ambiguous.coverageStatus, "partial");
  assert.equal(ambiguous.visibleMessages.length, 2);
  duplicateLegacy.payload.id = "shared";
  const proven = parseEvents([newSession(), duplicateLegacy, completedMessage("user", "duplicate", { id: "shared" })]);
  assert.equal(proven.coverageStatus, "supported");
  assert.equal(proven.visibleMessages.length, 1);
});

test("response-only model inputs, unknown content, nontext attachments and inherited scope are explicit gaps", () => {
  for (const response of [responseMessage("user", "Typed user"), responseMessage("assistant", "Typed final")]) {
    const parsed = parseEvents([newSession(), response]);
    assert.equal(parsed.visibleMessages.length, 0);
    assert.equal(parsed.coverageStatus, "unsupported");
  }
  const withImage = completedMessage("user", "Caption");
  withImage.payload.item.content.push({ type: "image", image_url: "PRIVATE IMAGE URL" });
  const attached = parseEvents([newSession(), withImage]);
  assert.equal(attached.coverageStatus, "unsupported");
  assert.deepEqual(attached.projectionCounts.nontext_blocks, { image: 1 });
  assert.equal(JSON.stringify(attached.diagnostics).includes("PRIVATE"), false);
  const inherited = newSession();
  inherited.payload.parent_thread_id = "parent-thread";
  const scoped = parseEvents([inherited, completedMessage("assistant", "Local response")]);
  assert.equal(scoped.coverageStatus, "partial");
  assert.ok(scoped.diagnostics.some((entry) => entry.code === "inherited_thread_scope_unsupported"));
});

test("private reasoning phases never supply captured bodies and async multipart visible text is not duplicated", () => {
  const prompt = completedMessage("assistant", "Pick one:\nA\nB  ", { phase: "commentary" });
  prompt.payload.item.delivery = "async";
  prompt.payload.item.questions = [{ title: "Pick one:", options: ["A", "B"] }];
  prompt.payload.item.content = [{ type: "Text", text: "Pick one:\n" }, { type: "Text", text: "A\nB  " }];
  const parsed = parseEvents([newSession(),
    agentMessage(NEW_TIME, "PRIVATE LEGACY", "analysis"),
    completedMessage("assistant", "PRIVATE CURRENT", { phase: "analysis" }), prompt,
  ]);
  assert.equal(parsed.coverageStatus, "supported");
  assert.deepEqual(parsed.visibleMessages.map((message) => message.text), ["Pick one:\nA\nB  "]);
  assert.equal(parsed.messageMetadata[0].delivery, "async");
  assert.deepEqual(parsed.messageMetadata[0].content_text_byte_lengths, [10, 5]);
  const unknown = parseEvents([newSession(), completedMessage("assistant", "Unclassified private possibility", { phase: "internal" })]);
  assert.equal(unknown.coverageStatus, "unsupported");
  assert.equal(unknown.visibleMessages.length, 0);
});

test("truncated JSON and invalid UTF-8 reject the whole source with metadata-only diagnostics", () => {
  const fixture = newFixture([newSession(), completedMessage("assistant", "Valid first message")]);
  fs.appendFileSync(fixture.sourcePath, '{"PRIVATE_SECRET":"unterminated');
  const summary = importCodexRollouts({ ...fixture, dryRun: false });
  assert.equal(summary.imported, 0);
  assert.equal(summary.rejected_malformed, 1);
  assert.equal(summary.coverage.status, "partial");
  assert.equal(summary.error_details[0].line, 3);
  assert.equal(JSON.stringify(summary).includes("PRIVATE_SECRET"), false);
  assert.equal(new FileBackedCatalog({ rootDir: fixture.catalogRoot }).listRecords("evidence").length, 0);
  assert.throws(() => parseCodexRollout({ sourcePath: fixture.sourcePath, sourceBytes: Buffer.from([0xff]) }), /invalid UTF-8/);
});

test("v1 zero-message fingerprints are reconsidered once and repeated current imports are idempotent", () => {
  const fixture = newFixture([newSession(), completedMessage("assistant", "Now supported")]);
  writeLegacyFingerprint(fixture);
  const first = importCodexRollouts({ ...fixture, dryRun: false });
  assert.equal(first.imported, 1);
  const state = JSON.parse(fs.readFileSync(first.import_state_file, "utf8"));
  assert.equal(state.version, 2);
  assert.equal(state.sources[fixture.sourcePath].parser_version, PARSER_VERSION);
  const second = importCodexRollouts({ ...fixture, dryRun: false });
  assert.equal(second.imported, 0);
  assert.equal(second.skipped_unchanged, 1);
  assert.equal(second.coverage.status, "complete");
  assert.equal(second.coverage.cached_sources, 1);
});

test("cached unsupported, no-visible and unknown outcomes remain coverage gaps", () => {
  for (const [events, expected] of [
    [[newSession(), responseMessage("user", "Unproven input")], "unsupported"],
    [[newSession()], "no_visible_messages"],
  ]) {
    const fixture = newFixture(events);
    const first = importCodexRollouts({ ...fixture, dryRun: false });
    const second = importCodexRollouts({ ...fixture, dryRun: false });
    assert.equal(second.skipped_unchanged, 1);
    assert.equal(second.coverage.status, "partial");
    assert.equal(second.coverage.source_statuses[expected], 1);
    const state = JSON.parse(fs.readFileSync(first.import_state_file, "utf8"));
    delete state.sources[fixture.sourcePath].coverage_status;
    fs.writeFileSync(first.import_state_file, JSON.stringify(state));
    const unknown = importCodexRollouts({ ...fixture, dryRun: false });
    assert.equal(unknown.coverage.source_statuses.unknown, 1);
  }
});

test("legacy parser reconsideration preserves exact payload bytes, hash, id and history", () => {
  const fixture = newFixture([newSession(), userMessage(NEW_TIME, "Exact legacy\t🙂  "), agentMessage(NEW_TIME, "Final\n", "final_answer")]);
  importCodexRollouts({ ...fixture, dryRun: false });
  const catalog = new FileBackedCatalog({ rootDir: fixture.catalogRoot });
  const record = catalog.listRecords("evidence")[0];
  const recordPath = catalog.getRecordPath("evidence", record.evidence_id);
  const beforeRecord = fs.readFileSync(recordPath);
  const beforePayload = fs.readFileSync(path.join(fixture.catalogRoot, record.verbatim_payload_ref));
  assert.equal(record.evidence_id, "ev_codex_thread_thread_new_20260913_100000000Z");
  const payload = JSON.parse(beforePayload);
  assert.equal(Object.hasOwn(payload, "capture_parser"), false);
  assert.equal(Object.hasOwn(payload, "message_metadata"), false);
  assert.equal(record.payload_hash, createSha256(beforePayload));
  const legacyBytes = `${JSON.stringify({
    capture_kind: "codex_rollout_snapshot", checkpoint_reason: "first_seen", thread_id: "thread_new",
    thread_name: null, thread_updated_at: null, source_rollout_path: fixture.sourcePath,
    session_started_at: NEW_TIME, captured_at: NEW_TIME, last_visible_message_at: NEW_TIME,
    source_observed_at: NEW_TIME, archived: false, cwd: "/synthetic/workspace", originator: "Codex Desktop",
    source: "vscode", cli_version: "0.119.0", model_provider: "openai", message_count: 2, final_answer_count: 1,
    messages: [
      { sequence: 1, timestamp: NEW_TIME, role: "user", phase: null, text: "Exact legacy\t🙂  " },
      { sequence: 2, timestamp: NEW_TIME, role: "assistant", phase: "final_answer", text: "Final\n" },
    ],
  }, null, 2)}\n`;
  assert.equal(beforePayload.toString("utf8"), legacyBytes);
  assert.equal(record.payload_hash, createSha256(legacyBytes));
  writeLegacyFingerprint(fixture);
  const again = importCodexRollouts({ ...fixture, dryRun: false });
  assert.equal(again.imported, 0);
  assert.equal(again.skipped_checkpoint, 1);
  assert.equal(catalog.listRecords("evidence").length, 1);
  assert.deepEqual(fs.readFileSync(recordPath), beforeRecord);
  assert.deepEqual(fs.readFileSync(path.join(fixture.catalogRoot, record.verbatim_payload_ref)), beforePayload);
});

test("selected preflight binds exact bytes and thread and rejects every batch before writes if one source has a gap", () => {
  const fixture = newFixture([newSession(), completedMessage("assistant", "Valid")]);
  const invalidRelative = "sessions/2026/09/13/bad.jsonl";
  writeRollout(fixture.codexRoot, invalidRelative, [newSession("thread_bad"), responseMessage("user", "Unproven")]);
  const badPath = path.join(fixture.codexRoot, invalidRelative);
  const selection = [selectSource(fixture.sourcePath, "thread_new"), selectSource(badPath, "thread_bad")];
  const result = importCodexRollouts({ ...fixture, dryRun: false, sourceSelection: selection });
  assert.equal(result.preflight.status, "blocked");
  assert.equal(result.not_attempted, 1);
  assert.equal(result.rejected_unsupported, 1);
  assert.equal(result.source_results.length, 2);
  assert.deepEqual(fs.readdirSync(fixture.catalogRoot), []);
  for (const invalid of [
    [selection[0], selection[0]],
    [{ ...selection[0], sha256: `sha256:${"0".repeat(64)}` }],
    [{ ...selection[0], threadId: "wrong-thread" }],
    [{ ...selection[0], path: path.join(fixture.catalogRoot, "outside.jsonl") }],
  ]) {
    assert.throws(() => importCodexRollouts({ ...fixture, dryRun: false, sourceSelection: invalid }));
    assert.deepEqual(fs.readdirSync(fixture.catalogRoot), []);
  }
});

test("selected evidence capture preserves unrelated ledger entries, suppresses seed writes and returns every receipt", () => {
  const fixture = newFixture([newSession(), completedMessage("assistant", "First")]);
  const selection = [];
  for (let index = 0; index < 12; index += 1) {
    const threadId = `thread_${index}`;
    const relative = `sessions/2026/09/13/selected-${index}.jsonl`;
    writeRollout(fixture.codexRoot, relative, [newSession(threadId), completedMessage("assistant", "Captured", { threadId })]);
    selection.push(selectSource(path.join(fixture.codexRoot, relative), threadId));
  }
  const statePath = path.join(fixture.catalogRoot, "state", "codex-rollouts.json");
  fs.mkdirSync(path.dirname(statePath));
  const unrelatedPath = path.join(fixture.codexRoot, "unselected-historical.jsonl");
  const unrelated = { fingerprint: "1:2", historical_field: { exact: "retain" } };
  fs.writeFileSync(statePath, JSON.stringify({ version: 1, sources: { [unrelatedPath]: unrelated } }));
  const originalAttach = CaseSeedStore.prototype.attachChatEvidence;
  CaseSeedStore.prototype.attachChatEvidence = () => { throw new Error("Seed writes forbidden in selected path"); };
  try {
    const result = importCodexRollouts({ ...fixture, dryRun: false, sourceSelection: selection });
    assert.equal(result.imported, 12, JSON.stringify(result));
    assert.equal(result.source_results.length, 12);
    assert.equal(result.sample_results.length, 10);
    assert.equal(result.coverage.accounted_rollouts, 12);
    assert.equal(result.case_seed_linking, "suppressed_evidence_only_selection");
    assert.deepEqual(JSON.parse(fs.readFileSync(statePath)).sources[unrelatedPath], unrelated);
    assert.equal(fs.existsSync(path.join(fixture.catalogRoot, "staging")), false);
  } finally {
    CaseSeedStore.prototype.attachChatEvidence = originalAttach;
  }
});

test("an incompatible existing immutable snapshot blocks selected backfill without ledger or evidence changes", () => {
  const legacy = [newSession(), userMessage(NEW_TIME, "Legacy user")];
  const fixture = newFixture(legacy);
  importCodexRollouts({ ...fixture, dryRun: false });
  const currentEvents = [...legacy, completedMessage("assistant", "Previously missed answer")];
  writeRollout(fixture.codexRoot, fixture.relativePath, currentEvents, NEW_TIME);
  const catalog = new FileBackedCatalog({ rootDir: fixture.catalogRoot });
  const record = catalog.listRecords("evidence")[0];
  const recordPath = catalog.getRecordPath("evidence", record.evidence_id);
  // Simulate the earlier parser's partial snapshot of these same source bytes.
  record.source_hash = createSha256(fs.readFileSync(fixture.sourcePath));
  fs.writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);
  const statePath = path.join(fixture.catalogRoot, "state", "codex-rollouts.json");
  const beforeState = fs.readFileSync(statePath);
  const beforeRecord = fs.readFileSync(recordPath);
  const beforePayload = fs.readFileSync(path.join(fixture.catalogRoot, record.verbatim_payload_ref));
  const result = importCodexRollouts({ ...fixture, dryRun: false, sourceSelection: [selectSource(fixture.sourcePath, "thread_new")] });
  assert.equal(result.preflight.status, "blocked");
  assert.equal(result.repair_required, 1);
  assert.equal(result.imported, 0);
  assert.deepEqual(fs.readFileSync(statePath), beforeState);
  assert.deepEqual(fs.readFileSync(recordPath), beforeRecord);
  assert.deepEqual(fs.readFileSync(path.join(fixture.catalogRoot, record.verbatim_payload_ref)), beforePayload);
});

test("same-source legacy body changes require repair instead of checkpoint skipping or fingerprint acceptance", () => {
  const events = [newSession(),
    agentMessage(NEW_TIME, "Previously captured internal text", "commentary"),
    agentMessage(NEW_TIME, "Exact visible final", "final_answer"),
  ];
  const fixture = newFixture(events);
  assert.equal(importCodexRollouts({ ...fixture, dryRun: false }).imported, 1);
  events[1].payload.phase = "analysis";
  writeRollout(fixture.codexRoot, fixture.relativePath, events, NEW_TIME);
  const catalog = new FileBackedCatalog({ rootDir: fixture.catalogRoot });
  const record = catalog.listRecords("evidence")[0];
  const recordPath = catalog.getRecordPath("evidence", record.evidence_id);
  const payloadPath = path.join(fixture.catalogRoot, record.verbatim_payload_ref);
  // Construct an immutable snapshot produced by the former legacy parser.
  const oldPayload = JSON.parse(fs.readFileSync(payloadPath, "utf8"));
  oldPayload.messages[0].phase = "analysis";
  const oldPayloadBytes = `${JSON.stringify(oldPayload, null, 2)}\n`;
  fs.writeFileSync(payloadPath, oldPayloadBytes);
  record.source_hash = createSha256(fs.readFileSync(fixture.sourcePath));
  record.payload_hash = createSha256(oldPayloadBytes);
  const oldRecordBytes = `${JSON.stringify(record, null, 2)}\n`;
  fs.writeFileSync(recordPath, oldRecordBytes);
  writeLegacyFingerprint(fixture);
  const result = importCodexRollouts({ ...fixture, dryRun: false });
  assert.equal(result.repair_required, 1);
  assert.equal(result.skipped_checkpoint, 0);
  assert.equal(result.skipped_existing, 0);
  assert.equal(result.skipped_unchanged, 0);
  assert.equal(result.coverage.source_statuses.repair_required, 1);
  const statePath = path.join(fixture.catalogRoot, "state", "codex-rollouts.json");
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(state.sources[fixture.sourcePath].parser_version, undefined);
  assert.equal(fs.readFileSync(recordPath, "utf8"), oldRecordBytes);
  assert.equal(fs.readFileSync(payloadPath, "utf8"), oldPayloadBytes);
  assert.equal(catalog.listRecords("evidence").length, 1);
  const stateBytes = fs.readFileSync(statePath);
  const selected = importCodexRollouts({ ...fixture, dryRun: false, sourceSelection: [selectSource(fixture.sourcePath, "thread_new")] });
  assert.equal(selected.preflight.status, "blocked");
  assert.equal(selected.repair_required, 1);
  assert.deepEqual(fs.readFileSync(statePath), stateBytes);
  assert.equal(fs.readFileSync(recordPath, "utf8"), oldRecordBytes);
  assert.equal(fs.readFileSync(payloadPath, "utf8"), oldPayloadBytes);
});

test("a legacy projection reduced to zero visible messages still checks immutable body compatibility", () => {
  const events = [newSession(), agentMessage(NEW_TIME, "Formerly captured internal text", "commentary")];
  const fixture = newFixture(events);
  importCodexRollouts({ ...fixture, dryRun: false });
  events[1].payload.phase = "analysis";
  writeRollout(fixture.codexRoot, fixture.relativePath, events, NEW_TIME);
  const catalog = new FileBackedCatalog({ rootDir: fixture.catalogRoot });
  const record = catalog.listRecords("evidence")[0];
  const recordPath = catalog.getRecordPath("evidence", record.evidence_id);
  const payloadPath = path.join(fixture.catalogRoot, record.verbatim_payload_ref);
  const oldPayload = JSON.parse(fs.readFileSync(payloadPath, "utf8"));
  oldPayload.messages[0].phase = "analysis";
  const oldPayloadBytes = `${JSON.stringify(oldPayload, null, 2)}\n`;
  fs.writeFileSync(payloadPath, oldPayloadBytes);
  record.source_hash = createSha256(fs.readFileSync(fixture.sourcePath));
  record.payload_hash = createSha256(oldPayloadBytes);
  fs.writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);
  writeLegacyFingerprint(fixture);
  for (const sourceSelection of [null, [selectSource(fixture.sourcePath, "thread_new")]]) {
    const result = importCodexRollouts({ ...fixture, dryRun: false, sourceSelection });
    assert.equal(result.repair_required, 1);
    assert.equal(result.skipped_no_visible_messages, 0);
    assert.equal(result.coverage.source_statuses.repair_required, 1);
    assert.equal(fs.readFileSync(payloadPath, "utf8"), oldPayloadBytes);
    const state = JSON.parse(fs.readFileSync(path.join(fixture.catalogRoot, "state/codex-rollouts.json"), "utf8"));
    assert.equal(state.sources[fixture.sourcePath].parser_version, undefined);
  }
});

test("selected write failures retain exact partial-write receipts without leaking error text or claiming rollback", () => {
  const fixture = newFixture([newSession(), completedMessage("assistant", "Synthetic content")]);
  const originalWrite = fs.writeFileSync;
  fs.writeFileSync = (target, ...args) => {
    if (typeof target === "string" && target.startsWith(path.join(fixture.catalogRoot, "evidence") + path.sep)) {
      throw new Error("PRIVATE FAILURE CONTENT");
    }
    return originalWrite(target, ...args);
  };
  try {
    const result = importCodexRollouts({ ...fixture, dryRun: false, sourceSelection: [selectSource(fixture.sourcePath, "thread_new")] });
    assert.equal(result.errors, 1);
    assert.equal(result.coverage.accounted_rollouts, 1);
    assert.equal(result.coverage.status, "partial");
    assert.equal(result.source_results[0].write_state.payload, "written");
    assert.equal(result.source_results[0].write_state.evidence, "uncertain");
    assert.equal(JSON.stringify(result).includes("PRIVATE FAILURE CONTENT"), false);
  } finally {
    fs.writeFileSync = originalWrite;
  }
});

test("selected preflight detects orphan payload conflicts before any valid peer or ledger is written", () => {
  const fixture = newFixture([newSession(), completedMessage("assistant", "Valid")]);
  const payloadPath = path.join(fixture.catalogRoot, "payloads/evidence/codex/rollouts/2026/09/ev_codex_thread_thread_new_20260913_100000000Z.json");
  fs.mkdirSync(path.dirname(payloadPath), { recursive: true });
  fs.writeFileSync(payloadPath, "Prior orphan bytes");
  const result = importCodexRollouts({ ...fixture, dryRun: false, sourceSelection: [selectSource(fixture.sourcePath, "thread_new")] });
  assert.equal(result.preflight.status, "blocked");
  assert.equal(result.conflicts, 1);
  assert.equal(result.imported, 0);
  assert.equal(fs.readFileSync(payloadPath, "utf8"), "Prior orphan bytes");
  assert.equal(fs.existsSync(path.join(fixture.catalogRoot, "state")), false);
});

const NEW_TIME = "2026-09-13T10:00:00.000Z";

function newSession(id = "thread_new") {
  return sessionMeta({ id, timestamp: NEW_TIME, cwd: "/synthetic/workspace" });
}

function completedMessage(role, text, options = {}) {
  const phase = Object.hasOwn(options, "phase") ? options.phase : "final_answer";
  return {
    type: "event_msg", timestamp: options.timestamp ?? NEW_TIME,
    payload: {
      type: "item_completed", thread_id: options.threadId ?? "thread_new", turn_id: options.turn ?? "turn-new",
      item: {
        type: role === "user" ? "UserMessage" : "AgentMessage",
        id: Object.hasOwn(options, "id") ? options.id : `${role}-id`,
        content: [{ type: role === "user" ? "text" : "Text", text }],
        ...(role === "assistant" && phase !== null ? { phase } : {}),
        ...(options.memoryCitation ? { memory_citation: options.memoryCitation } : {}),
      },
    },
  };
}

function responseMessage(role, text, options = {}) {
  return {
    type: "response_item", timestamp: options.timestamp ?? NEW_TIME,
    payload: {
      type: "message", role, id: options.id ?? null,
      content: [{ type: role === "user" ? "input_text" : "output_text", text }],
      ...(role === "assistant" ? { phase: options.phase ?? "final_answer" } : {}),
      ...(options.metadata === false ? {} : { internal_chat_message_metadata_passthrough: {
        turn_id: options.turn ?? "turn-new", content_item_kinds: options.kinds ?? [role === "user" ? "user.text" : "assistant.text"],
      } }),
    },
  };
}

function parseEvents(events) {
  return parseCodexRollout({
    sourcePath: "/synthetic/sessions/thread.jsonl",
    sourceBytes: Buffer.from(`${events.map((event) => JSON.stringify(event)).join("\n")}\n`),
    sourceStat: { mtime: new Date(NEW_TIME) },
  });
}

function newFixture(events) {
  const codexRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-codex-v2-root-")));
  const catalogRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-codex-v2-catalog-")));
  const relativePath = "sessions/2026/09/13/rollout-thread_new.jsonl";
  writeRollout(codexRoot, relativePath, events, NEW_TIME);
  return { codexRoot, catalogRoot, relativePath, sourcePath: path.join(codexRoot, relativePath) };
}

function selectSource(sourcePath, threadId) {
  return { path: sourcePath, sha256: createSha256(fs.readFileSync(sourcePath)), threadId };
}

function writeLegacyFingerprint(fixture) {
  const stat = fs.statSync(fixture.sourcePath);
  const statePath = path.join(fixture.catalogRoot, "state", "codex-rollouts.json");
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify({ version: 1, sources: {
    [fixture.sourcePath]: { fingerprint: `${stat.size}:${Math.trunc(stat.mtimeMs)}` },
  } }));
}

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

function candidateCloseout() {
  return {
    decision: "candidate",
    seed: {
      future_decision: "Decide whether chat evidence should support a run-backed ECITR seed.",
      activate_when: "A Codex snapshot source_locator exactly equals a seed thread_ref.",
      do_not_apply_when: "The source_locator differs even if it looks similar.",
      plan_effect: "Attach chat evidence as provenance only.",
      problem: "Chat evidence should attach by exact thread_ref without changing seed meaning.",
      constraints: "No fuzzy matching and no transcript-based semantic rewrite.",
      action_taken: "Attached matching chat evidence to the case seed links.",
      outcome: "The seed retained agent-authored semantics and gained chat provenance.",
      failure_mode: "Fuzzy matching can attach unrelated conversations.",
      confidence: 0.82,
    },
  };
}
