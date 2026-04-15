# MemPalace Adapter

This adapter will allow ECITR to use MemPalace as an evidence substrate.

Boundary rule:
- MemPalace may store and retrieve evidence.
- MemPalace may not become the canonical owner of cases, invariants, tactics, or retrieval policy.

## Current Spike State

- local checkout path: `external/mempalace/`
- pinned commit: `a036b4300d46fe6d399f8f89347f816462dd2c22`
- inspected entry points:
  - `mempalace/cli.py`
  - `mempalace/searcher.py`
  - `mempalace/palace.py`
  - `mempalace/config.py`

The current ECITR adapter does not yet hand off live evidence writes or reads to MemPalace.

It currently does three things:
- pins the inspected checkout
- exposes the execution boundary ECITR will call later
- prevents the MemPalace substrate from bypassing ECITR validation or lifecycle rules
