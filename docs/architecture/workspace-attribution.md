# Workspace Attribution

## Purpose

Define how one shared ECITR catalog preserves project identity without making
repo-local catalogs or retrieval backends authoritative.

## Topology

The ECITR runtime uses one canonical file-backed catalog. A repo-local
`ecitr.project.json` marker identifies the workspace and exposes memory policy;
it does not create a second canonical corpus.

Catalog routing and source attribution are separate checks:

- importers may use a repo marker to attribute source evidence even when that
  marker still names a repo-local catalog path;
- `ProjectMemorySurface` still requires the configured catalog path to match
  the catalog it actually opens;
- retrieval always filters by the attributed `workspace_id`.

## Resolution Order

Agent-ops records resolve by:

1. explicit caller override;
2. explicit `config/workspace-source-map.json` entry;
3. active project id or alias in the configured agent-ops project registry;
4. catalog marker fallback.

Codex rollout records resolve by:

1. explicit caller override;
2. nearest valid `ecitr.project.json` marker;
3. explicit workspace-root source-map entry;
4. active agent-ops registry workspace root, including markerless Git worktrees
   resolved through `.git/commondir`;
5. catalog marker fallback.

Catalog fallback is sufficient for ordinary import compatibility but is not an
authoritative migration signal. Migration acts only on explicit source
selectors or active registry entries. A configured but unavailable registry
fails closed before fallback.

## Correction Rules

- Evidence attribution is corrected by appending a new evidence record with a
  deterministic id and `correction_of`; the original file is never edited.
- Parameter definitions and observations receive workspace-derived ids.
  Corrected observations cite current evidence corrections, and definition
  first-seen metadata is derived from the target workspace's own earliest
  admitted observation. Legacy support records remain on disk.
- Cases, invariants, tactics, case seeds, and governed promotion packets receive
  attribution corrections under a validated migration manifest. Their semantic
  version, review state, and lifecycle status do not change.
- Live promotion candidates are different because `workspace_id` is part of
  candidate semantics. The reviewed candidate remains unchanged; migration
  appends a new staged latest-series revision with empty decision history.
- A record with mixed or unresolved lineage is blocked and reported. The
  migrator does not infer a dominant workspace.

Each applied migration is journaled under
`state/workspace-attribution-migrations/`. The manifest stores selectors,
before/after records, deterministic hashes, blockers, and apply status.
Registry-wide application plans from one catalog snapshot, rejects targets
claimed by multiple workspaces, and preflights every operation before the first
catalog write.

## Derived State

Support graph, LanceDB, and Qdrant state remain derived. Refresh them only after
the canonical catalog migration is complete and validated.
