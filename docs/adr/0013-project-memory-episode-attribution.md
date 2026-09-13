# Project-memory episode attribution

Status: accepted for bounded implementation, 2026-09-13.

Owner: Retrieval Architect, with Orchestrator and Governance/QA review.
Class: derived contract and compatibility change at the retrieval interface.

## Problem

A nonempty lifecycle string currently counts as a joined opportunity even when
it is a bare session ID or belongs to a different task project. Identity presence
does not establish a source-backed episode association.

## Decision

New nested telemetry uses version 2. Version 1 remains readable under its
unchanged schema, and existing anchors keep their original version. The outer
invocation and anchor identity/paths remain version 1. No historical backfill or
canonical-record migration is performed.

Version 2 records a bounded, literal session inspection through the existing
source map's agent-ops registry root. Session references must be canonical
`memory/sessions/YYYY/MM/session_*.json` paths. No bare-ID expansion, alias,
time/thread lookup, arbitrary URL read or nearest-session heuristic is allowed.
Missing, unresolved, invalid and verified attribution are separate states.

The session's literal project is separate from the retrieval marker's workspace.
Unequal identities require an explicit `cross_workspace` relation declaration.
Validation establishes source identity correspondence and matching declarations;
it does not establish business intent, authorization or native agent identity.
Supplied thread and run references must agree with literal session metadata;
an absent run or an active session does not acquire an inferred outcome.

Stable identity fields are checked before reusing an anchor. Capture-time source
hashes identify inspected bytes; ordinary later session closeout does not change
the stable session ID/project/thread association. Anchors are not rewritten to
upgrade an old attribution snapshot.

The existing usage callback and decision/output-reference fields remain
compatible and optional. Reports expose missing references on reported use.
Declarations, corroborated use and measured benefit remain separate.

## Scope and non-goals

Changes cover telemetry/context validation, the existing producer/report/CLI,
schemas, focused tests, the canonical telemetry document and Codex guidance.
Retrieval ranking, policy, marker shape, caps, canonical corpus, history and
agent-ops lifecycle mechanics are unchanged. There is no new ledger or logging
step and no additional evidence requirement for performing ordinary work.

## Risks, validation and rollback

Owner metadata may be unavailable; attribution then stays unresolved while the
existing consult/skip path remains usable. Bounded source reads add overhead.
Tests cover exact same/cross-workspace identity, unsupported references,
unavailable/malformed/nonregular/aliased sources, mismatched identity, anchor
reuse, optional callbacks and v1 compatibility. `npm run check` is required.
The parent independently checks source/session/run/output correspondence and
wrapper routing; fixtures do not establish natural memory benefit.

Rollback reverts the scoped source/guidance change. Preserve all historical
artifacts under their literal versions; an older report may classify v2 as
unsupported. No data rewrite or index/corpus migration is required.
