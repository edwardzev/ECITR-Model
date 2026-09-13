const { TextDecoder } = require("node:util");

const PARSER_VERSION = "codex-visible-v2";
const VISIBLE_PHASES = new Set(["commentary", "final_answer"]);
const CONTEXT_KINDS = new Set([
  "plugins.recommendations", "agents_md.instructions", "environments.environment_context",
]);

function malformedRollout(line, reason) {
  const error = new Error(`Codex rollout ${reason}${line ? ` at line ${line}` : ""}.`);
  error.code = "malformed_rollout";
  if (line) error.line = line;
  return error;
}

function parseRolloutEvents(sourceBytes) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(sourceBytes);
  } catch {
    throw malformedRollout(null, "has invalid UTF-8");
  }
  const events = [];
  for (const [index, line] of text.split("\n").entries()) {
    if (line.length === 0) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      // JSON.parse diagnostics may quote private message bytes.
      throw malformedRollout(index + 1, "has invalid JSON");
    }
    if (!event || typeof event !== "object" || Array.isArray(event) || typeof event.type !== "string") {
      throw malformedRollout(index + 1, "has an invalid event envelope");
    }
    events.push({ event, line: index + 1 });
  }
  if (events.length === 0) throw malformedRollout(null, "is empty");
  return events;
}

function extractVisibleMessages(events, threadId) {
  const primary = [];
  const responses = [];
  const diagnostics = [];
  const families = new Set();
  const completedIds = new Map();
  const counts = { excluded_context: 0, response_projections: 0, duplicate_projections: 0, nontext_blocks: {} };
  let activeTurn = null;
  const issue = (line, code) => diagnostics.push({ line, code });

  for (const { event, line } of events) {
    const payload = event.payload;
    if (event.type === "turn_context" || (event.type === "event_msg" && payload?.type === "task_started")) {
      activeTurn = payload?.turn_id ?? activeTurn;
    }
    if (event.type === "event_msg" && ["user_message", "agent_message"].includes(payload?.type)) {
      families.add("legacy");
      const role = payload.type === "user_message" ? "user" : "assistant";
      if (role === "assistant" && ["analysis", "reasoning"].includes(payload.phase)) continue;
      if (role === "assistant" && payload.phase != null && !VISIBLE_PHASES.has(payload.phase)) {
        issue(line, "unsupported_legacy_assistant_phase");
        continue;
      }
      if (typeof payload.message !== "string") {
        issue(line, "unsupported_legacy_message_text");
        continue;
      }
      if (!isValidTimestamp(event.timestamp)) issue(line, "unsupported_message_timestamp");
      if ((payload.images?.length ?? 0) > 0 || (payload.local_images?.length ?? 0) > 0) {
        issue(line, "unsupported_visible_attachment");
      }
      primary.push({
        family: "legacy", line, turn: payload.turn_id ?? activeTurn,
        id: payload.id ?? payload.item_id ?? null,
        timestamp: event.timestamp, role,
        phase: role === "user" ? null : payload.phase ?? null,
        text: payload.message,
      });
      continue;
    }
    if (event.type === "event_msg" && payload?.type === "item_completed") {
      const item = payload.item;
      if (!item || typeof item !== "object" || typeof item.type !== "string") {
        issue(line, "unsupported_completed_item");
        continue;
      }
      if (!["UserMessage", "AgentMessage"].includes(item.type)) {
        if (/message/i.test(item.type) && !["SystemMessage", "DeveloperMessage", "ToolMessage"].includes(item.type)) {
          issue(line, "unsupported_completed_message_type");
        }
        continue;
      }
      families.add("completed");
      if (payload.thread_id != null && payload.thread_id !== threadId) {
        issue(line, "completed_thread_identity_mismatch");
        continue;
      }
      const role = item.type === "UserMessage" ? "user" : "assistant";
      if (role === "assistant" && ["analysis", "reasoning"].includes(item.phase)) continue;
      if (role === "assistant" && item.phase != null && !VISIBLE_PHASES.has(item.phase)) {
        issue(line, "unsupported_completed_assistant_phase");
        continue;
      }
      const expectedType = role === "user" ? "text" : "Text";
      const text = textContent(item.content, expectedType);
      if (text === null) {
        if (Array.isArray(item.content)) {
          for (const block of item.content) {
            if (typeof block?.type === "string" && block.type !== expectedType) {
              // Types, never media URLs or other attachment bytes, are diagnostic.
              const type = ["image", "Image", "audio", "Audio"].includes(block.type) ? block.type : "unknown";
              counts.nontext_blocks[type] = (counts.nontext_blocks[type] ?? 0) + 1;
            }
          }
        }
        issue(line, "unsupported_completed_content");
        continue;
      }
      if (!isValidTimestamp(event.timestamp)) issue(line, "unsupported_message_timestamp");
      const candidate = {
        family: "completed", line, turn: payload.turn_id ?? activeTurn,
        id: item.id ?? null, timestamp: event.timestamp, role,
        phase: role === "user" ? null : item.phase ?? null, text,
        memoryCitation: item.memory_citation ?? null,
        delivery: item.delivery ?? null,
        textBlockByteLengths: item.content.map((block) => Buffer.byteLength(block.text, "utf8")),
      };
      const identity = candidate.id && candidate.turn
        ? JSON.stringify([threadId, candidate.turn, item.type, candidate.id]) : null;
      if (identity && completedIds.has(identity)) {
        const existing = completedIds.get(identity);
        if (existing.text !== candidate.text || existing.phase !== candidate.phase) {
          issue(line, "conflicting_completed_message_identity");
        } else {
          counts.duplicate_projections += 1;
        }
        continue;
      }
      if (identity) completedIds.set(identity, candidate);
      primary.push(candidate);
      continue;
    }
    if (event.type !== "response_item" || payload?.type !== "message") continue;
    if (!["user", "assistant"].includes(payload.role)) continue;
    const metadata = payload.internal_chat_message_metadata_passthrough;
    responses.push({
      family: "response", line, turn: metadata?.turn_id ?? activeTurn,
      id: payload.id ?? null, timestamp: event.timestamp,
      role: payload.role, phase: payload.phase ?? channelPhase(payload.channel),
      content: payload.content, kinds: metadata?.content_item_kinds ?? null,
    });
  }

  // Distinct printed occurrences remain distinct. Cross-family suppression
  // requires an explicit shared identity, never text/time equality alone.
  const printed = [];
  for (const message of primary) {
    const counterpart = printed.find((candidate) => candidate.family !== message.family
      && candidate.role === message.role && candidate.turn && candidate.turn === message.turn
      && candidate.id && candidate.id === message.id);
    if (counterpart) {
      if (counterpart.text !== message.text || counterpart.phase !== message.phase) {
        issue(message.line, "conflicting_printed_projections");
      } else {
        counts.duplicate_projections += 1;
        if (message.family === "legacy") Object.assign(counterpart, message);
      }
    } else {
      if (printed.some((candidate) => candidate.family !== message.family && candidate.role === message.role
        && candidate.turn && candidate.turn === message.turn
        && candidate.timestamp === message.timestamp && candidate.text === message.text)) {
        issue(message.line, "ambiguous_printed_projections");
      }
      printed.push(message);
    }
  }

  const matched = new Set();
  for (const response of responses) {
    if (response.role === "user" && Array.isArray(response.kinds)
      && response.kinds.length === response.content?.length
      && response.kinds.every((kind) => CONTEXT_KINDS.has(kind))) {
      counts.excluded_context += 1;
      continue;
    }
    const roleTextType = response.role === "user" ? "input_text" : "output_text";
    const text = textContent(response.content, roleTextType);
    const sameTurn = (message) => !response.turn || !message.turn || response.turn === message.turn;
    const counterpart = printed.find((message) => !matched.has(message)
      && message.role === response.role && sameTurn(message)
      && ((response.role === "assistant" && response.id && response.id === message.id)
        || (Math.abs(message.line - response.line) === 1 && text !== null && message.text === text)));
    if (counterpart) {
      matched.add(counterpart);
      counts.response_projections += 1;
      if (counterpart.family === "completed" && counterpart.role === "assistant"
        && counterpart.phase === null && text === counterpart.text && VISIBLE_PHASES.has(response.phase)) {
        counterpart.phase = response.phase;
        counterpart.phaseSourceLine = response.line;
      }
      continue;
    }
    if (response.role === "assistant" && response.phase === "analysis") continue;
    if (text === null) {
      issue(response.line, "unsupported_response_content");
      continue;
    }
    if (response.role === "user" && (!Array.isArray(response.kinds)
      || response.kinds.length !== response.content.length
      || !response.kinds.every((kind) => kind === "user.text"))) {
      issue(response.line, "unclassified_response_user_visibility");
      continue;
    }
    if (response.role === "assistant" && !VISIBLE_PHASES.has(response.phase)) {
      issue(response.line, "unclassified_response_assistant_visibility");
      continue;
    }
    if (printed.some((message) => sameTurn(message) && message.role === response.role && message.text === text)) {
      issue(response.line, "ambiguous_response_projection");
      continue;
    }
    // A model input/output representation alone does not prove UI delivery.
    issue(response.line, "unmatched_response_without_printed_event");
  }

  for (const message of printed) {
    if (message.family === "completed" && message.role === "assistant" && message.phase === null) {
      issue(message.line, "unknown_completed_assistant_phase");
    }
  }
  const ordered = printed.sort((left, right) => left.line - right.line);
  const messages = ordered
    .map((message, index) => ({
      sequence: index + 1,
      timestamp: message.timestamp,
      role: message.role,
      phase: message.phase,
      text: message.text,
    }));
  const format = families.size > 1 ? "mixed"
    : families.has("legacy") ? "legacy"
      : families.has("completed") ? "current_completed" : "unknown";
  return {
    visibleMessages: messages,
    messageMetadata: ordered.map((message, index) => ({
      sequence: index + 1,
      source_family: message.family,
      source_line: message.line,
      native_message_id: message.id,
      native_turn_id: message.turn,
      native_thread_id: threadId,
      ...(message.phaseSourceLine ? { phase_source_line: message.phaseSourceLine } : {}),
      ...(message.memoryCitation ? { memory_citation: message.memoryCitation } : {}),
      ...(message.delivery ? { delivery: message.delivery } : {}),
      ...(message.textBlockByteLengths ? { content_text_byte_lengths: message.textBlockByteLengths } : {}),
    })),
    finalAnswerCount: messages.filter((message) => message.role === "assistant" && message.phase === "final_answer").length,
    format,
    coverageStatus: diagnostics.length > 0 ? (messages.length > 0 ? "partial" : "unsupported")
      : messages.length > 0 ? "supported" : "no_visible_messages",
    diagnostics: diagnostics.slice(0, 20),
    diagnosticCount: diagnostics.length,
    projectionCounts: counts,
  };
}

function textContent(content, expectedType) {
  if (!Array.isArray(content) || content.length === 0
    || content.some((block) => !block || block.type !== expectedType || typeof block.text !== "string")) return null;
  return content.map((block) => block.text).join("");
}

function channelPhase(channel) {
  if (channel === "final") return "final_answer";
  return channel ?? null;
}

function isValidTimestamp(timestamp) {
  return typeof timestamp === "string" && !Number.isNaN(new Date(timestamp).getTime());
}

module.exports = { PARSER_VERSION, parseRolloutEvents, extractVisibleMessages, malformedRollout };
