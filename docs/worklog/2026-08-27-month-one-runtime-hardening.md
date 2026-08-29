# 2026-08-27 Month-One Runtime Hardening

## Change Packet

- Title: Preserve historical workspace identity and stop no-op live-candidate revisions
- Owner: ECITR Orchestrator
- Change class: Cross-layer runtime and lifecycle hardening
- Affected surfaces: agent-ops source attribution, selective workspace migration,
  live promotion candidate staging, tests, and architecture documentation

## Motivation

The month-one operational review found two defects in otherwise current derived
state:

- autonomous refresh had reported failure on every run since 2026-08-12 because
  inactive registry entries were excluded from historical agent-ops source
  attribution;
- the production project-memory factory rejected a current LanceDB basis after
  correction parents were removed, silently selecting heuristic retrieval;
- unchanged live invariant and tactic candidates created new revisions whenever
  generated lifecycle dates changed, producing 1,250 revisions and no
  activations across 25 observed promotion runs.

The support graph and LanceDB basis were current when inspected. This change is
therefore limited to the two confirmed runtime defects rather than expanding
retrieval or graph authority.

## Proposed Change

- Load all registered agent-ops project identities for exact historical
  project-id and alias attribution.
- Keep active-only registry lists for Codex cwd discovery, default rollout, and
  registry-wide migration targeting.
- Permit a known inactive workspace to be selected explicitly by the existing
  dry-run-first attribution migrator.
- Carry exact planned run evidence ids into the session-import dry-run so a
  sequential refresh validates new parent links without writing catalog state.
- Validate LanceDB against the complete immutable correction graph while
  keeping lane-facing evidence limited to current correction leaves.
- Exclude generated `entry.created_at` and `entry.revalidate_at` values from
  live-candidate discovery semantics.
- Preserve existing candidate content, status, decision history, creation date,
  and revalidation horizon when normalized discovery semantics are unchanged.
- Recognize legacy timestamp-sensitive hashes once and upgrade them in place
  without creating a semantic revision.

## Non-Goals

- Do not activate, retire, revalidate, or promote canonical records.
- Do not apply workspace migrations automatically.
- Do not broaden inactive workspaces into active Codex discovery or default
  registry-wide migration.
- Do not change retrieval ranking, schemas, graph authority, or public APIs.

## Risks

- Treating every inactive registry field as active would revive retired
  workspaces. The implementation limits inactive use to exact historical
  agent-ops identity and explicit migration selection.
- Ignoring a true tactic validity change would hide semantic drift. Only the two
  generated lifecycle fields are excluded; tool, environment, steps, support,
  and provenance fields remain semantic.
- Recomputing a reviewed candidate hash from narrowed text could transfer a
  decision incorrectly. The compatibility comparison uses incoming discovery
  semantics with persisted lifecycle dates, while the persisted reviewed entry
  remains untouched.

## Validation Plan

- Prove inactive project ids resolve for agent-ops evidence but not Codex cwd
  discovery or default migration.
- Prove explicit inactive migration is dry-run-only unless `--apply` is given.
- Prove a refresh dry-run accepts session links only when their parent run is
  either canonical already or planned by the same run-import pass.
- Prove a correction-rich current LanceDB basis selects the LanceDB backend and
  returns the correction leaf rather than its parent.
- Prove cross-day invariant and tactic discovery creates no revision and does
  not extend lifecycle dates.
- Prove a reviewed legacy candidate keeps its status, narrowed entry, and
  decision history during hash normalization.
- Run focused tests and `npm run check`.
- Run live read-only import and candidate-staging diagnostics against the shared
  catalog.

## Rollback Plan

Revert the source-mapping, selective-migration, and candidate-hash changes as a
single unit. No canonical rollback is required unless a separately authorized
workspace migration is later applied; such an apply produces its own journaled
manifest and immutable evidence corrections.

## Documentation Impact

`docs/architecture/workspace-attribution.md` now distinguishes historical
identity from active discovery and documents explicit inactive-workspace repair.

## Initial Results

- Focused regressions passed.
- A live candidate dry-run classified all 25 invariant and 25 tactic candidates
  as unchanged, with zero planned revisions.
- Explicit migration dry-runs found 25 QRchimp and 2 CRM Enrich Engine evidence
  corrections, with zero blockers. Applying those corrections remains a
  separate governed migration decision.
- A disposable catalog-copy proof initially applied 24 run/session corrections and then scanned
  3,852 agent-ops runs and 4,099 sessions with zero conflicts and zero errors.
- Independent review subsequently found three QRchimp Codex chat records under
  the inactive registered workspace root; the final canonical migration must
  therefore apply 27 corrections and re-run the same proof.
- Production-path probes selected LanceDB three times and heuristic fallback
  zero times across Printee, Reklamis, and MSBC; all returned records matched
  the requested workspace.
- The shared canonical catalog was not migrated or otherwise mutated by these
  proofs.
