# Conversation Evidence Runbook

## Purpose

Explain how ECITR captures chat conversations as native `EvidenceRecord`s without relying on `agent-ops` runtime machinery.

## Core Rule

Conversation capture is ECITR-native.

The canonical record in `evidence/` uses `source_type: "chat"`.

There are now two ECITR-owned paths:

- manual snapshot capture for exact ad hoc transcript preservation
- Codex rollout import for ongoing Codex-wide conversation capture

## Runtime Command

Refresh Codex-native conversation evidence from local Codex storage into
`.local/catalog` and run structural capture checks:

```bash
npm run refresh:codex
```

This reads from `~/.codex` by default. Supported printed bodies come from legacy
`user_message` / `agent_message` events and current completed `UserMessage` /
`AgentMessage` items. Current completed items are authoritative for printed
text; internal response projections can contain injected context, inherited
history or extra citation markup and are not interchangeable with that text.

Body text, whitespace and legitimate repeated messages are preserved. Current
capture records source identity and available citation/phase provenance.
Nontext content is counted as excluded: this path does not preserve attachment
bytes or claim complete UI fidelity. Unsupported associations and ambiguous
inherited history remain explicit coverage gaps. Private reasoning, tool
results and nested compaction histories are not conversation body text.

This manual import command does not rebuild derived semantic state. The
autonomous refresh wrapper performs the final LanceDB sync after all canonical
refresh and promotion stages complete.

## Runtime Policy

Codex rollout refresh now follows a checkpoint policy instead of writing a new snapshot for every changed file.

Unchanged rollout files are skipped early through a local import-state fingerprint
ledger under the catalog root. Parser compatibility is part of the checkpoint:
legacy entries are reconsidered after a parser upgrade, and cached no-visible or
unsupported outcomes remain coverage gaps rather than becoming successful
captures. Unknown state versions or malformed checkpoint entries are rejected
without silently discarding unrelated history.

Changed threads create a new immutable evidence snapshot only when one of these conditions is true:

- first time the thread is seen
- a new `final_answer` appeared since the latest imported snapshot
- the thread moved into archived state
- at least `7` days elapsed since the latest imported snapshot
- at least `100` printed messages were added since the latest imported snapshot

Changed threads that do not cross one of those checkpoints are intentionally not written into canonical evidence on that refresh.

## Bounded Compatibility Backfill

Use a reviewed source manifest to restrict a repair to exact native files and
observed source bytes. Each entry binds the source path, its SHA-256 hash and
the literal session thread ID:

```json
{
  "version": 1,
  "sources": [
    {
      "path": "/absolute/native/sessions/rollout-example.jsonl",
      "sha256": "sha256:<64 lowercase hexadecimal characters>",
      "thread_id": "<literal session_meta.id>"
    }
  ]
}
```

Preview before capture:

```bash
npm run refresh:codex -- --source-manifest /absolute/path/manifest.json --dry-run
npm run refresh:codex -- --source-manifest /absolute/path/manifest.json
```

Selected sources must be regular files under the allowed native session/archive
roots. All selected paths, hashes, thread identities, extraction results and
immutable compatibility are checked before writes. Processing uses the same
bytes that passed preflight. A changing source requires a newly observed and
verified boundary; never silently expand a manifest or substitute a different
thread. A partial final JSON record is not complete source evidence.

Manifest repair preserves unselected checkpoint entries and suppresses
case-seed linking. It does not promote cases, invariants or tactics. Existing
immutable evidence is not replaced; incompatible prior content is reported as
`repair_required` for a separately specified correction.

Retain the manifest and complete per-source results. Repeating a successful
manifest must not create duplicate snapshots. After a write failure, inspect
the exact committed/uncertain state before resuming: preflight is not a
transactional rollback guarantee. Reverting code does not remove or rewrite
evidence already captured.

Run a controlled batch with other scheduled and manual capture writers idle.
The import-state lock protects checkpoint publication; it does not serialize
the entire catalog and payload import. Existing snapshots, including legacy
ones, require compatible visible message bodies before checkpoint reuse.

## Coverage and Integrity

The import and refresh summaries expose `coverage` separately from process
success. It accounts for candidates, source dispositions, cached sources and
explicit gaps. `complete`, `partial` and `empty` describe the observed scope
under the supported printed-text contract; they are not guarantees that every
historical conversation, attachment, host or cloud account was archived.

The autonomous report forwards this as `codex_capture_coverage` and emits a
warning for partial coverage. The compact scheduled-run output includes its
status and gap count. Missing coverage is `unavailable`, never zero gaps or
complete capture. A top-level `ok: true` establishes process execution only.

Capture coverage and payload integrity are separate checks. Before a backfill,
record the existing catalog and payload hashes. After capture, independently
compare the selected source bodies and identities with stored payloads, verify
payload hashes and idempotence, and confirm old evidence is byte-identical.
Source hashes identify the exact observed source boundary; an active native
rollout may subsequently grow. Neither matching hashes nor successful capture
establishes backup or permanent retention guarantees.

## Manual Snapshot Command

Capture a conversation snapshot from a JSON messages file:

```bash
npm run capture:conversation -- --conversation-key audit_memory_sytem --messages-file /absolute/path/to/messages.json
```

## Message File Shape

The messages file must be a JSON array. Each entry must preserve exact text:

```json
[
  { "role": "user", "text": "Exact user text." },
  { "role": "assistant", "text": "Exact assistant text." }
]
```

Allowed roles:

- `user`
- `assistant`
- `system`

## Defaults

- catalog root: `.local/catalog`
- project scope: `project`
- source locator: `codex-thread://<conversation-key>`
- payload namespace: `payloads/evidence/ecitr/conversations/...`
- Codex runtime root: `~/.codex`
- Codex runtime payload namespace: `payloads/evidence/codex/rollouts/...`

## Snapshot Rule

- each capture creates a new immutable evidence record
- later captures for the same conversation automatically link to the previous snapshot with `parent_evidence_id`
- ECITR does not mutate an older conversation evidence record in place
- Codex rollout refresh imports one immutable snapshot per checkpointed thread state using the thread id plus the checkpoint capture timestamp

## Scheduled Cadence

The intended default cadence for Codex runtime refresh is low-frequency, not near-live:

- scheduled refresh once per day overnight
- manual refresh when recent chat evidence is needed sooner

The intended scheduler owner is ECITR itself through the local `launchd` job.
The installed job runs the autonomous wrapper, which captures Codex evidence,
refreshes parameter support and case drafts, runs governed promotion, refreshes
the support graph, and independently syncs the derived LanceDB index:

```bash
npm run refresh:codex:launchd -- install
```

Status and removal commands:

```bash
npm run refresh:codex:launchd -- status
npm run refresh:codex:launchd -- uninstall
```

`launchd` should run missed calendar jobs once the machine wakes, so the practical target remains the first successful run after the machine is active again.

Each scheduled run writes its full structured summary under
`.local/reports/autonomous-refresh/` and retains the newest `30` reports. The
same summary is atomically published as `latest.json`. The launchd stdout stream
contains only a compact report pointer and status summary.
Oversized stdout and stderr logs rotate at `5 MiB`, with `5` generations retained.

## Boundary

This gives ECITR a native way to persist conversations into the evidence corpus.

It does not by itself create a platform-level automatic hook for every future UI turn outside the existence of Codex local rollout storage plus an ECITR refresh trigger.
