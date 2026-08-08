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

This reads from `~/.codex` by default and imports printed `user_message` and `agent_message` events from Codex rollout files.

This manual import command does not rebuild derived semantic state. The
autonomous refresh wrapper performs the final LanceDB sync after all canonical
refresh and promotion stages complete.

## Runtime Policy

Codex rollout refresh now follows a checkpoint policy instead of writing a new snapshot for every changed file.

Unchanged rollout files are skipped early through a local import-state fingerprint ledger under the catalog root.

Changed threads create a new immutable evidence snapshot only when one of these conditions is true:

- first time the thread is seen
- a new `final_answer` appeared since the latest imported snapshot
- the thread moved into archived state
- at least `7` days elapsed since the latest imported snapshot
- at least `100` printed messages were added since the latest imported snapshot

Changed threads that do not cross one of those checkpoints are intentionally not written into canonical evidence on that refresh.

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
