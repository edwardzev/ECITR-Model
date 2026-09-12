const { validateTelemetryContext } = require("../runtime/project-memory-telemetry");

const FLAGS = {
  "--episode-id": "episode_id", "--thread-ref": "thread_ref", "--session-ref": "session_ref",
  "--run-ref": "run_ref", "--lane": "lane", "--audit-mode": "audit_mode",
  "--decision-reason": "decision_reason", "--retry-of": "retry_of",
};

function readTelemetryOption(options, argument, value) {
  const field = FLAGS[argument];
  if (!field) return false;
  if (value === undefined || value.startsWith("--")) throw new Error("Telemetry option requires a value.");
  options.telemetryContext ??= {};
  options.telemetryContext[field] = value;
  validateTelemetryContext(options.telemetryContext);
  return true;
}

function captureGap(error) {
  return {
    ok: false,
    error: error.memory_invocation ? error.code ?? "retrieval_failed" : "project_memory_failed_before_attempt_capture",
    memory_invocation: error.memory_invocation ?? null,
    capture_gap: error.memory_invocation ? null : "no_instrumented_attempt_available; configuration, excluded lane or pre-decision validation may have failed",
  };
}

module.exports = { readTelemetryOption, captureGap };
