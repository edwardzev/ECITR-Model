# AGENTS.md

## Repo Identity

- Repo path: `/Users/edwardzev/ECITR-Model`
- Primary purpose: Evidence-Cases-Invariants-Tactics-Retrieval architecture,
  schemas, runtime, validation, retrieval, and governed promotion machinery.
- ECITR is not a continuation of `/Users/edwardzev/agent-ops`; agent-ops is
  historical prior art and an input source only where explicitly wired.

## Truth Sources

Read these before changing architecture, runtime, schemas, or retrieval:

- `/Users/edwardzev/ECITR-Model/README.md`
- `/Users/edwardzev/ECITR-Model/docs/00-start-here.md`
- `/Users/edwardzev/ECITR-Model/docs/architecture/system-map.md`
- `/Users/edwardzev/ECITR-Model/docs/architecture/retrieval-control-plane.md`
- `/Users/edwardzev/ECITR-Model/docs/architecture/retrieval-runtime.md`
- `/Users/edwardzev/ECITR-Model/docs/architecture/record-lifecycle.md`
- `/Users/edwardzev/ECITR-Model/docs/change-control.md`
- `/Users/edwardzev/ECITR-Model/schemas/ecitr_project.schema.json`
- `/Users/edwardzev/ECITR-Model/config/workspace-source-map.json`
- `/Users/edwardzev/ECITR-Model/package.json`
- `/Users/edwardzev/ECITR-Model/ecitr.project.json`

## Core Contracts

- Authority flows one way: `Evidence -> Cases -> Invariants/Tactics`.
- Retrieval finds, ranks, and fuses records; retrieval does not own semantic
  truth.
- Evidence is immutable.
- Cases are versioned.
- Invariants are tool-agnostic.
- Tactics are tool-, version-, and environment-bound.
- Retrieval must remain pluggable and replaceable without rewriting canonical
  records.
- The human interacts with the Orchestrator, not directly with specialist
  agents.

## Schema And Marker Rules

- `/Users/edwardzev/ECITR-Model/schemas/ecitr_project.schema.json` owns ECITR
  workspace marker shape.
- Workspace docs may explain local marker use, but must not invent marker
  fields.
- Do not edit `ecitr.project.json` files, schema files, or
  `config/workspace-source-map.json` as incidental cleanup.
- Schema, layer-contract, retrieval, migration, and semantic-boundary changes
  must follow `/Users/edwardzev/ECITR-Model/docs/change-control.md`.

## Runtime And Data Rules

- Treat `.local/` catalog and invocation output as runtime/generated state
  unless the task explicitly asks to inspect it.
- Do not copy raw evidence records, private thread text, raw customer data, or
  sensitive logs into summaries unless explicitly required and safe.
- Preserve workspace ids, record ids, case ids, invariant ids, tactic ids, and
  evidence ids exactly.
- Do not backfill, migrate, promote, or rewrite records without explicit task
  authorization and validation.

## Governance Signals

Trigger governance review when:

- a schema changes;
- a record lifecycle rule changes;
- retrieval ranking, fusion, invalidation, or workspace scoping changes;
- source-map behavior changes;
- agent-ops import or Codex capture behavior changes;
- generated runtime state is proposed as canonical truth.

Detailed repo evolution trigger logic belongs to `$repo-governor`; this file is
only the repo-local reminder.

## Validation

- For schema/runtime changes, run `npm run check` unless the task scope gives a
  narrower approved validation.
- For fixture or schema changes, include fixture validation in the check path.
- For AGENTS-only edits, verify the file exists and references the current
  schema, change-control, source-map, and package surfaces.
