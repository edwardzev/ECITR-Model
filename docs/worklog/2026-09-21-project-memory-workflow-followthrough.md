# Project-memory workflow follow-through

Scope: reduce manual context/reference entry and expose per-invocation callback
gaps using existing telemetry. Retrieval Architect and Governance/QA accepted
the bounded plan before implementation through the Orchestrator.

- Search/skip accept an explicit canonical `--session-file` and derive only its
  session/thread references through configured owner validation. Direct flags
  remain supported; no current-session inference or context file is created.
- Usage accepts repeatable inline reference objects. Missing references remain
  accepted and visible; invalid claims cannot mutate the invocation.
- Producer responses expose attribution status and exact callback targets. The
  report lists individual missing callbacks and reference gaps, retaining sibling
  attempts separately.
- Skill examples use those existing-workflow conveniences. Elapsed retrieval
  durations remain distinct from CPU, active work, model tokens and cost.

Validation uses isolated source-map/owner/catalog fixtures and actual wrappers.
It proves delivery and compatibility behavior, not ordinary adoption or memory
benefit. The broader observation gaps and owner/security obligations remain
separate; no historical records or retrieval policies are changed here.
