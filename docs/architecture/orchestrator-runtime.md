# Orchestrator Runtime

## Purpose

Define the first executable runtime surface for the Orchestrator.

## Core Rule

The Orchestrator routes explicit task packets through a role registry.

It does not improvise hidden ownership.

## Runtime Stages

1. accept a task packet
2. classify affected layers and change class
3. choose a primary role
4. choose supporting roles when needed
5. mark whether orchestrator review remains required
6. emit a delegation plan

## Retrieval Hook

The execution loop may now accept either:
- an explicit `retrievalRequest`
- or a runtime `intervention` input

Rules:
- explicit `retrievalRequest` wins and preserves the existing behavior
- `intervention` is an adapter-owned runtime hook, not a new task or retrieval schema
- intervention execution still returns normal retrieval output plus a smaller intervention envelope
- intervention artifacts remain derived `.local` files rather than catalog records

## Workspace Memory Surface

Workspaces may now declare an ECITR memory surface through a root `ecitr.project.json` marker.

The marker declares:
- workspace identity
- catalog location
- default project scope
- whether preflight retrieval is mandatory
- whether failure-retry retrieval is mandatory

Current phase rule:
- the memory surface is visible by default when the marker exists
- normal task execution does not force retrieval when both mandatory flags are false
- the execution loop exposes a first-class discretionary affordance through `search_project_memory`
- usage can be recorded later through `record_memory_usage`
- an already-requested retrieval receives an observational shadow-gate result
  that cannot suppress execution

Repo-local or harness integrations can use the concrete CLI surfaces:
- `npm run memory:log-opportunity -- --task-id ... --task-title ...`
- `npm run search:project-memory -- --query ... --trigger discretionary|preflight|failure_retry`
- `npm run memory:record-usage -- --invocation-id ... --used-record-ids ...`
- `npm run memory:report-invocations`

When invoked from a marked repository, these commands resolve
`ecitr.project.json` from the current working directory. `--workspace-root`,
`--workspace-id`, and `--artifact-root` remain available as explicit overrides.

The report exposes the experiment denominator (`task_opportunities`),
consultation rate, trigger mix, returned layer counts, usage-callback rate, and
confirmed memory-use rate.

The execution loop should expose:
- whether project memory is available
- the named tool affordance
- the workspace identity that retrieval will use
- the default scope and policy flags
- a per-run memory invocation artifact summary
- the shadow gate classification when retrieval was executed

Memory invocation artifacts, including shadow gate results, remain derived
`.local` files rather than canonical records.

## Role Rule

Every routed task must name:
- a primary role
- zero or more supporting roles
- whether Researcher is required
- whether Governance and QA review is required

## Escalation Rule

The runtime must force explicit orchestrator review for:
- cross-layer work
- retrieval-class changes
- contract-class changes
- external-adaptation changes
