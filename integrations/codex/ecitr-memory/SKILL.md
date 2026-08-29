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

Use `--trigger preflight` or `--trigger failure_retry` only when that is the actual reason for consultation. Keep queries concrete and scoped; do not treat broad lexical matches as proof.

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

Use retrieved records as guidance only after checking their scope, lifecycle state, provenance, and applicability to the current source state.
