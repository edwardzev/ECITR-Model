# Source Layout

Implementation code will be split by layer and adapters:
- `evidence/`
- `cases/`
- `invariants/`
- `tactics/`
- `retrieval/`
- `retrieval/embedders/`
- `retrieval/semantic-backends/`
- `support-graph/`
- `orchestrator/`
- `storage/`
- `review/`
- `cli/`
- `adapters/mempalace/`
- `validation/`
- `lifecycle/`

The first implementation surface is:
- schema validation
- lifecycle and supersession rules
- evidence write gates
- storage-backed catalog persistence
- adapter boundaries
- atomic-claim extraction
- review workflow
- persisted review audit entries
- packet-based promotion pipelines
- retrieval execution and fusion
- pluggable semantic backend seam
- embedded LanceDB semantic backend derived from the canonical catalog
- local deterministic embedder for prototype sync and benchmark runs
- derived support-graph snapshots, diffs, and internal graph queries
- orchestrator delegation runtime
