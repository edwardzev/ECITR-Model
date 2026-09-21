---
name: ecitr-memory
description: Consult and measure governed ECITR project memory for substantive repository work when a workspace has ecitr.project.json, especially when prior decisions, failures, parameters, or successful implementation paths may prevent rediscovery.
---

# ECITR Memory

Use the workspace marker as the routing contract. ECITR is a governed source of prior evidence, cases, invariants, and tactics; it does not override current repository truth, live provider state, or existing authorization boundaries.

## Decide

- Skip this skill for `micro` work and for workspaces without `ecitr.project.json`.
- In a strict no-write audit, do not search or log an opportunity because both operations create invocation artifacts. Report that constraint if retrieval would otherwise be required.
- For substantive work, search when prior decisions, known failures, parameters, tool/version constraints, or successful paths could materially change the approach.
- Respect `preflight_retrieval_mandatory` and `failure_retry_retrieval_mandatory` in the marker. Otherwise retrieval is discretionary.
- Do not search merely to satisfy ceremony. If no search is warranted, log one no-consult opportunity for the task instead.

## Search

Run from the project workspace so marker discovery and workspace attribution remain authoritative:

```bash
~/.codex/skills/ecitr-memory/scripts/search_project_memory \
  --query "specific task, failure, parameter, or decision" \
  --task-id "stable-task-id" \
  --task-title "short task title" \
  --session-file "/absolute/agent-ops/memory/sessions/YYYY/MM/session_....json" \
  --lane governed-write \
  --trigger discretionary
```

Use the known agent-ops owner root plus the exact `session_ref` returned by
`open_memory_session` for the absolute file path. The runtime validates its owner,
ID and project, and carries its literal session and stored thread references.
No new file or session lookup is needed. Choose
the actual lane; the example is not a default. Alternatively, pass the returned
canonical `--session-ref memory/sessions/YYYY/MM/session_....json` and applicable
`--thread-ref`/`--episode-id` directly. Bare IDs are not session references.
If task project and retrieval workspace intentionally differ, also declare
`--task-workspace-relation cross_workspace`; this grants no execution authority.
Check `memory_invocation.episode_attribution`: missing or invalid direct context
stays unjoined; an invalid `--session-file` fails before capture. Conflicting
file/flag identities are rejected. Reuse the same context and task ID throughout
the episode. For an actual retry, also pass `--retry-of` with the prior attempt
ID. The wrapper creates the opportunity and attempt; do not log before searching.

Use `--trigger preflight` or `--trigger failure_retry` only when that is the actual reason for consultation. Keep queries concrete and scoped; do not treat broad lexical matches as proof.

## Read Selected Records

Select up to five literal IDs from that invocation's `returned_record_ids`, read their content, then assess applicability against current source truth before reporting use:

```bash
~/.codex/skills/ecitr-memory/scripts/read_project_memory_records \
  --invocation-id "meminv_..." \
  --record-ids "case_...,tac_..."
```

The reader returns complete eligible case/invariant/tactic records. Evidence defaults to metadata. To request one catalog-owned evidence excerpt, include that returned evidence ID in `--record-ids` and add `--evidence-id "ev_..." --start-line 1 --end-line 20`. Lines are one-based and inclusive; the reader preserves exact bytes and verifies the sidecar payload hash. It does not follow live source locators.

Read results can be `available`, `empty`, `denied`, or `stale`. Do not substitute a correction or treat denied/budget-limited content as inspected. `legacy_unpinned` means current content was checked but its retrieval-time match is unknown; an invocation without its original request is denied. Respect prerequisites, negative applicability, fallbacks and rollback in the complete record.

Reading updates the same invocation with a preparation receipt. It does not prove host delivery, agent attention, use, usefulness, or execution authority. It does not set usage fields. Identical reads reuse a receipt; at most 20 distinct receipts are retained, with no eviction. The CLI emits no body if receipt persistence fails. Reader updates are also prohibited in a strict no-write audit.

## Record Outcome

After every search, call the usage wrapper with that search's exact
`memory_invocation.usage_followthrough.invocation_id`. Each retry has its own
target; a sibling callback does not cover it. Include only materially influential
IDs and an existing decision/output reference when available:

```bash
~/.codex/skills/ecitr-memory/scripts/record_memory_usage \
  --invocation-id "meminv_..." \
  --used-record-ids "case_..." \
  --use-evidence '{"record_id":"case_...","output_ref":"/absolute/task/output.md#decision"}'
```

Repeat `--use-evidence` for additional links. When no returned record influenced
the work, call the wrapper with only `--invocation-id` for an explicit empty
callback. Never manufacture empty callbacks, use or references to fill gaps.

If an eligible substantive task ends without a search, log exactly one opportunity and do not also log a no-consult opportunity for a task that already searched:

```bash
~/.codex/skills/ecitr-memory/scripts/log_memory_opportunity \
  --task-id "stable-task-id" \
  --task-title "short task title" \
  --session-file "/absolute/agent-ops/memory/sessions/YYYY/MM/session_....json" \
  --lane diagnostic
```

The no-consult wrapper also accepts `--query`, `--trigger` and
`--decision-reason` for the actual task decision. Both branches capture a shadow
gate observation after the caller has selected the wrapper. This is recorded as
`caller_selected_before_dispatch`, not before-agent-choice coverage. Native
external-agent choice coverage remains unavailable; no new logging call or
retrieval-skip policy is introduced. If a search fails
after capture starts, its error envelope supplies `memory_invocation` so the
existing callback can still record no returned influence. A missing marker or
other pre-capture failure exposes a capture gap and creates no fallback artifact.

The callback also accepts `--selected-record-ids`, `--inspected-record-ids` and
the existing `--use-evidence-file` array. References remain optional declarations,
not independently verified influence or benefit. Callback output lists used IDs
without references; invocation reports list exact missing callback targets and
reference gaps. Check those results instead of treating one callback as episode
coverage. An empty callback and a missing callback remain separate states.

Use retrieved records as guidance only after checking their scope, lifecycle state, provenance, and applicability to the current source state.
