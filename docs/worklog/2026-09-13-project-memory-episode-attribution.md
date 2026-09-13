# Project-memory episode attribution repair

Approved packet: [ADR 0013](../adr/0013-project-memory-episode-attribution.md).
Defect: `defect_20260913173213230_19010332_mcp_01`.

The primary Orchestrator and independent Retrieval Architect/QA reviewer
accepted the bounded plan before implementation. The accepted adjustment keeps
usage evidence optional and records its absence rather than adding a new gate.

Implemented nested telemetry v2 with source-backed session attribution, explicit
cross-workspace declarations, anchor consistency checks and version 1 read/reuse
compatibility. Reporting version 3 separates lifecycle declarations from verified
source metadata and exposes optional usage-reference gaps. The v1 telemetry
schema, retrieval policy, ranking, markers and callback write contract are
unchanged.

Validation before parent integration:

- 34 focused context/telemetry tests passed, including source identity, path and
  byte bounds, source drift, reciprocal run checks, anchor immutability and v1
  compatibility.
- The required `npm run check` passed fixture validation and all 466 tests,
  including the final usage-reference coverage assertions and existing
  selected-reader, retrieval, invocation and execution-loop compatibility.
- Dependencies were resolved from the existing canonical `node_modules` through
  `NODE_PATH`; no dependency installation or canonical config mutation occurred.

The parent owns independent source/session/run/output proof, concrete diff
review, publication and activation. These fixture results do not establish
natural memory influence, total task cost or measured benefit.
