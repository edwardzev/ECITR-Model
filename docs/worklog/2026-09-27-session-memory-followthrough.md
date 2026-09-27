# Exact-session memory follow-through

Owner: primary governance integrator; independent read-only reviewer covers
ECITR observability and caller-boundary QA. Approved task: complete existing
task/session, per-search callback and stored-result connections.

The prior review found omitted caller task references and searches whose sibling
callback did not cover them. This local observability change extends the existing
invocation report with exact-session scope and adds a thin installed wrapper.
It is an operational projection, with no change to retrieval ranking, canonical
record schemas, promotion, markers, or memory authority.

The reviewed design reuses agent-ops owner/registry/session attribution, bounded
invocation reads, duplicate quarantine and callback summaries. It exposes missing
native identity separately from exact session attribution; unknown enumeration
coverage stays explicit. All deliveries for an invocation identity are considered
before session conflict quarantine. Historical records are never modified.

Caller instructions pass known host-owned identity to the existing open call,
reuse its response context, check each search's callback, and independently read
back the reciprocal stored run after closeout. Agent-ops completion retains its
existing independence: no ECITR runtime dependency or new closeout gate.

Validation covers exact session isolation, missing/sibling callbacks, explicit
skip versus unobserved, missing/legacy native identity, reciprocal closeout,
wrong owners and runs, conflicting deliveries, unsafe/unreadable sources,
concurrent source changes, declared cross-workspace use, preserved bytes, and
operation with an unavailable catalog. Independent review identified and corrected
three false-acceptance paths: conflicting workspace/catalog bindings, malformed
callback references or returned-ID declarations, and unverified attempt run links.
Focused regressions preserve legitimate legacy reported IDs and later reciprocal
run attachment. The repository check remains required;
installed entry points and a complete caller workflow require separate readback.

Risks: a supplied artifact root cannot establish global invocation coverage;
readback after concurrent changes must remain uncertain; instructions cannot
guarantee that an external host supplies task identity. Returned references and
usage declarations do not establish memory benefit. No latency or token-saving
claim is part of this batch.

Rollback: revert this scoped commit and restore the prior installed skill files
and narrowly changed global instruction lines from recorded pre-activation bytes.
Do not revert unrelated instructions, rewrite historical invocations or restart
agent-ops: its runtime is unchanged. The original aggregate report remains
available without session options.

Release validation: the revised full `npm run check` passed all fixture validation
and 505 tests. Independent read-only review accepted the corrected candidate
after one revision round. Read-only checks on existing episodes detected two
known missing callbacks and a separate missing native-task reference, while the
current episode had an exact task/session link and explicit skip. Installed
entry-point and post-closeout readback are recorded separately at activation.
