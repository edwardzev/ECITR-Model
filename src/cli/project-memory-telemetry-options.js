const { validateTelemetryContext } = require("../runtime/project-memory-telemetry");
const { contextFromSessionFile } = require("../runtime/project-memory-context");

const FLAGS = {
  "--episode-id": "episode_id", "--thread-ref": "thread_ref", "--session-ref": "session_ref",
  "--run-ref": "run_ref", "--lane": "lane", "--audit-mode": "audit_mode",
  "--decision-reason": "decision_reason", "--retry-of": "retry_of",
  "--task-workspace-relation": "task_workspace_relation",
};

function readTelemetryOption(options, argument, value) {
  const field = FLAGS[argument];
  if (!field && argument !== "--session-file") return false;
  if (value === undefined || value.startsWith("--")) throw new Error("Telemetry option requires a value.");
  if (argument === "--session-file") {
    if (options.sessionFile != null && options.sessionFile !== value) {
      throw Object.assign(new Error("Conflicting session files."), { telemetry_context_error: "telemetry_option_conflict" });
    }
    options.sessionFile = value;
    return true;
  }
  options.telemetryContext ??= {};
  if (Object.hasOwn(options.telemetryContext, field) && options.telemetryContext[field] !== value) {
    throw Object.assign(new Error("Conflicting telemetry options."), { telemetry_context_error: "telemetry_option_conflict" });
  }
  options.telemetryContext[field] = value;
  validateTelemetryContext(options.telemetryContext);
  return true;
}

function resolveTelemetryOptions(options, projectConfig) {
  const context = options.telemetryContext ?? {};
  validateTelemetryContext(context);
  if (options.sessionFile == null) return context;
  try {
    return contextFromSessionFile({ sessionFile: options.sessionFile, projectConfig, context });
  } catch (error) {
    error.telemetry_context_error = error.code ?? "session_file_unavailable";
    throw error;
  }
}

function captureGap(error) {
  return {
    ok: false,
    error: error.memory_invocation ? error.code ?? "retrieval_failed" : "project_memory_failed_before_attempt_capture",
    memory_invocation: error.memory_invocation ?? null,
    context_error: error.telemetry_context_error ?? null,
    capture_gap: error.memory_invocation ? null : "no_instrumented_attempt_available; configuration, excluded lane or pre-decision validation may have failed",
  };
}

module.exports = { readTelemetryOption, resolveTelemetryOptions, captureGap };
