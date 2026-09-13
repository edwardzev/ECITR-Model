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
  --trigger discretionary
```

When an existing memory session or episode reference is available, pass its literal
`--session-ref` or `--episode-id` with `--thread-ref` and `--lane` as applicable.
For `--session-ref`, copy the exact `session_ref` returned by `open_memory_session`,
including `memory/sessions/YYYY/MM/` and `.json`. Its bare `session_...` ID does not
resolve as a session reference. The runtime reads the task project from that
canonical session; no separate task-project flag is needed. If the task's project
and the retrieval workspace intentionally differ, add
`--task-workspace-relation cross_workspace`. This declares that relationship;
it does not change retrieval scope or grant cross-project authority. Missing or
invalid attribution stays visible as an unjoined opportunity.
Use that same lifecycle identity on retries and no-consult records. The wrappers
assign the opportunity and attempt automatically; do not add a separate logging
call before a search. Missing lifecycle identity is reported as unjoined coverage.

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

After every search, call the usage wrapper exactly once with the returned `memory_invocation.invocation_id`. Include only record IDs that materially influenced the work. Call it even when no record was used:

```bash
~/.codex/skills/ecitr-memory/scripts/record_memory_usage \
  --invocation-id "meminv_..." \
  --used-record-ids "case_...,tactic_..." \
  --selected-record-ids "case_...,tactic_..."
```

If an eligible substantive task ends without a search, log exactly one opportunity and do not also log a no-consult opportunity for a task that already searched:

```bash
~/.codex/skills/ecitr-memory/scripts/log_memory_opportunity \
  --task-id "stable-task-id" \
  --task-title "short task title"
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

The usage wrapper optionally accepts `--inspected-record-ids` and
`--use-evidence-file`, containing decision/output and independent-support
reference declarations. These remain self-reports until independently verified.
When memory materially influences a decision or output, include its existing
`decision_ref` or `output_ref` with the used record ID. Do not manufacture use or
evidence to fill telemetry. References remain optional; reported use without them
is recorded with an explicit reference-coverage gap.
An empty callback and no recorded callback remain separate states.

Use retrieved records as guidance only after checking their scope, lifecycle state, provenance, and applicability to the current source state.
