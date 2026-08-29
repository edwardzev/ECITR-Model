# 2026-08-29 Cross-Repository Memory Rollout

## Change Packet

- Title: Expose shared ECITR memory across registered workspaces
- Owner: ECITR Orchestrator
- Change class: Cross-repository runtime adoption and governance integration
- Affected surfaces: workspace markers, project-memory CLIs, invocation
  reporting, Codex skill installation, agent-ops project bootstrap, and rollout
  validation

## Motivation

The canonical catalog and retrieval runtime were healthy, but most registered
repositories either had no marker or pointed at an empty repo-local catalog.
Agents therefore could not reliably discover the shared corpus, and the
experiment lacked a cross-workspace denominator for measuring discretionary
consultation.

## Implemented Contract

- Keep one shared canonical catalog at
  `/Users/edwardzev/ECITR-Model/.local/catalog`.
- Preserve `evidence -> cases -> invariants/tactics` authority and existing
  public retrieval contracts.
- Install a discoverable `$ecitr-memory` skill with wrappers for search, usage
  callbacks, and no-consult opportunity logging.
- Keep retrieval discretionary when both marker policy flags are false.
- Record exactly one opportunity per eligible substantive task and one usage
  callback per search.
- Add registry-wide marker sync, rollout doctor, and aggregate adoption report
  CLIs.
- Make new agent-ops project registrations route to the shared catalog by
  default while preserving an explicit catalog override.

## Safety Rules

- Marker sync is dry-run by default.
- Existing scope and mandatory-policy flags are preserved.
- Equivalent resolved catalog paths are not rewritten.
- Existing untracked or modified markers that need migration are blocked rather
  than overwritten.
- Graph, LanceDB, parameters, and invocation artifacts remain derived/support
  state and do not gain canonical authority.
- No mandatory retrieval flags, planner semantics, ranking, promotion gates, or
  public response schemas changed.

## Applied Rollout

- Registered inventory: 42 active workspaces across 43 roots.
- Conflict-free roots made operational: 36.
- Marker operations: 23 created, 11 rerouted, and 2 already correct.
- Remote default branches updated: 18 repositories.
- Additional checked-out feature branches updated: 2 repositories.
- Local-only Git commits because no remote exists: 3 repositories.
- Non-Git roots updated locally: 13.
- Owner-controlled marker conflicts left untouched: 7 roots (`bitrix24`,
  `classic_art_test`, `colibri_digital`, `dr_fu_king`, `email_agent`,
  `reklamis_site`, and `ushpezin`).

The canonical 27-record workspace-attribution migration was applied before this
rollout and an autonomous refresh subsequently completed with current support
graph and LanceDB bases.

## Validation

- ECITR fixture and runtime suite: 302 tests passed.
- Agent-ops suite: 111 tests passed.
- Generic skill passed `quick_validate.py` and Bash syntax validation.
- Post-apply marker dry-run: 0 creates, 0 updates, 36 unchanged, 7 blocked.
- Rollout doctor: shared catalog readable, support graph fresh, LanceDB basis
  and table current, skill installed, and all 36 conflict-free roots ready.
- Aggregate adoption reporting excluded mismatched workspace artifacts and the
  live post-hardening report showed zero attribution mismatches.

## Follow-Up

- Exercise retrieval and callback logging from pilot workspaces.
- Review adoption metrics after 48 hours and seven days.
- Do not tighten discretionary policy until consultation rate, callback
  completeness, actual-use rate, scope suppression, and failure behavior are
  observed.
- Resolve each blocked marker only with its repository owner; do not bypass the
  ownership guard.

## Monitoring

- `ecitr-48-hour-adoption-check`: active task-attached heartbeat every 48 hours.
- `ecitr-seven-day-adoption-assessment`: active weekly local automation scoped
  to the ECITR project.

Both monitors use `2026-08-29T11:43:00Z` as the experiment baseline and are
read-only. They may report or recommend a later policy review but may not
change markers, mandatory flags, retrieval behavior, catalog records, derived
indexes, code, or governance.
