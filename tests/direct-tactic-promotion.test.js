const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { FileBackedCatalog } = require("../src/storage/file-backed-catalog");
const { TacticDiscoverySurface } = require("../src/tactics/discovery");
const { TacticReviewSurface } = require("../src/tactics/review");

test("direct case-cluster tactic can be approved without supporting invariants", () => {
  const rootDir = createCatalogWithDaemonCases();
  const surface = new TacticDiscoverySurface({ catalogRoot: rootDir });

  const result = surface.evaluateCandidate(makeDirectTacticEntry());

  assert.equal(result.actual_decision, "approve");
  assert.deepEqual(result.packet_preview.supporting_invariant_refs, []);
});

test("direct case-cluster tactic requires stronger source case support", () => {
  const rootDir = createCatalogWithDaemonCases();
  const surface = new TacticDiscoverySurface({ catalogRoot: rootDir });

  const result = surface.evaluateCandidate({
    ...makeDirectTacticEntry(),
    title: "Inventory export synchronization",
    summary: "Synchronize customer inventory exports after storefront reconciliation.",
    action: "Update customer inventory export tables after storefront reconciliation completes.",
    tool_binding: ["inventory-export"],
    environment_bounds: ["workspace:storefront"],
    prerequisites: [
      "A storefront inventory export table exists.",
      "Customer inventory rows have been reconciled.",
    ],
    steps: [
      "Update customer inventory export tables after storefront reconciliation completes and validate row counts.",
    ],
    fallbacks: [
      "Pause the export sync and rerun inventory reconciliation.",
    ],
    rollback: [
      "Restore the prior inventory export table snapshot.",
    ],
  });

  assert.equal(result.actual_decision, "block");
  assert.match(result.reasons.join("\n"), /not strongly supported by every source case/);
});

test("process-only direct case-cluster tactic is rejected", () => {
  const rootDir = createCatalogWithDaemonCases();
  const surface = new TacticDiscoverySurface({ catalogRoot: rootDir });

  const result = surface.evaluateCandidate({
    ...makeDirectTacticEntry(),
    steps: [
      "Review the daemon migration cases and discuss the plan with the operator before deciding what to do.",
    ],
  });

  assert.equal(result.actual_decision, "block");
  assert.match(result.reasons.join("\n"), /substantive operational steps/);
});

test("direct case-cluster tactic promotion persists an active tactic with empty invariant refs", () => {
  const rootDir = createCatalogWithDaemonCases();
  const surface = new TacticReviewSurface({ catalogRoot: rootDir });

  const result = surface.promoteCandidate({
    entry: makeDirectTacticEntry(),
    reviewer: "autonomous-governance-steward",
    rationale: "Direct case-cluster tactic is narrow, tool-bound, and repeated across active cases.",
    reviewedAt: "2099-01-01T00:00:00.000Z",
    dryRun: false,
  });

  const catalog = new FileBackedCatalog({ rootDir });
  const active = catalog.getRecord("tactic", result.next_record.id);
  assert.equal(active.status, "active");
  assert.equal(active.promotion_basis, "case_cluster");
  assert.deepEqual(active.supporting_invariant_refs, []);
});

function createCatalogWithDaemonCases() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-direct-tactic-"));
  const catalog = new FileBackedCatalog({ rootDir });
  catalog.writeRecord("case", makeDaemonCase({
    case_id: "case_daemon_mcp_http_a",
    problem_statement: "Agent ops daemon migration left duplicate stdio MCP processes because Codex config launched node on each reload.",
    action_taken: "Implement daemon healthcheck endpoint and switch Codex MCP config to local HTTP URL while preserving stdio rollback.",
    outcome: "Duplicate MCP processes stopped and healthcheck verified one daemon instance.",
    failure_mode: "Per-reload stdio launch created multiple MCP processes without shared concurrency control.",
  }));
  catalog.writeRecord("case", makeDaemonCase({
    case_id: "case_daemon_mcp_http_b",
    problem_statement: "Codex reload created duplicate agent ops MCP node processes while the daemon migration lacked a healthcheck gate.",
    action_taken: "Implement daemon healthcheck endpoint, preserve stdio rollback, and switch Codex MCP config to the local HTTP URL.",
    outcome: "Reloads reused the daemon endpoint and stopped spawning duplicate MCP processes.",
    failure_mode: "MCP stdio startup on every reload duplicated the process instead of sharing daemon concurrency.",
  }));
  return rootDir;
}

function makeDaemonCase({
  case_id,
  problem_statement,
  action_taken,
  outcome,
  failure_mode,
}) {
  return {
    case_id,
    case_version: 1,
    workspace_id: "agent_ops",
    status: "active",
    problem_statement,
    context: {
      constraints: [
        "Codex config can target a local HTTP MCP endpoint.",
        "Stdio rollback must remain available during daemon migration.",
      ],
      project_scope: "project",
      toolchain: ["agent-ops-daemon", "codex-mcp", "stdio-rollback"],
    },
    action_taken,
    outcome,
    failure_mode,
    applicability: {
      when_to_apply: [
        "An MCP server is being migrated from per-reload stdio launch to a daemon HTTP endpoint.",
      ],
      when_not_to_apply: [
        "The MCP server has no daemon mode or cannot expose a local HTTP endpoint.",
      ],
    },
    evidence_refs: [`ev_${case_id}`],
    review_state: "approved",
    confidence: 0.86,
    derived_at: "2099-01-01T00:00:00.000Z",
    derivation_rule_id: "test-case-rule",
  };
}

function makeDirectTacticEntry() {
  return {
    label: "daemon_http_config_switch",
    expected_decision: "approve",
    promotion_basis: "case_cluster",
    series_key: "live.agent_ops.daemon-http-config-switch",
    title: "Switch MCP config to daemon HTTP after healthcheck",
    summary: "Use daemon healthcheck, local HTTP MCP config, and stdio rollback when duplicate MCP processes come from per-reload node launch.",
    action: "Implement daemon healthcheck endpoint, switch Codex MCP config to local HTTP URL, and keep stdio rollback.",
    source_case_refs: ["case_daemon_mcp_http_a", "case_daemon_mcp_http_b"],
    supporting_invariant_refs: [],
    evidence_refs: ["ev_case_daemon_mcp_http_a", "ev_case_daemon_mcp_http_b"],
    parameter_observation_refs: [],
    tool_binding: ["agent-ops-daemon", "codex-mcp"],
    tool_version_bounds: ">=0.1.0 <1.0.0",
    environment_bounds: ["workspace:agent_ops", "transport:http-local"],
    prerequisites: [
      "The MCP server can run as a single local daemon.",
      "Codex can be configured to target the local HTTP MCP URL.",
    ],
    steps: [
      "Implement daemon healthcheck endpoint and singleton process behavior before changing Codex MCP config.",
      "Update Codex MCP config to use the local HTTP URL only after healthcheck passes and keep stdio rollback.",
    ],
    fallbacks: [
      "Revert Codex MCP config to stdio rollback if daemon healthcheck fails.",
    ],
    rollback: [
      "Stop the daemon endpoint and restore the previous stdio MCP command.",
    ],
    revalidate_at: "2099-03-01T00:00:00.000Z",
    validated_on: ["agent ops daemon migration cases"],
    confidence: 0.88,
    created_at: "2099-01-01T00:00:00.000Z",
  };
}
