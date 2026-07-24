const YAML = require("yaml");
const TOML = require("toml");

const {
  formatRawValueText,
  getSourceLocatorExtension,
  inferValueType,
  lineSpan,
  loadEvidencePayloadWithText,
  parseScalarLiteral,
} = require("./common");

const STRATEGY_IDS = Object.freeze({
  chat: "parameter-distiller-chat-v1",
  file: "parameter-distiller-file-v1",
  diff: "parameter-distiller-diff-v1",
  log: "parameter-distiller-log-v1",
});

function distillParameterEntries({
  evidenceRecord,
  catalogRoot,
  extractedAt = null,
  extractedBy = "parameter-distiller",
} = {}) {
  const distiller = DISTILLERS[evidenceRecord.source_type];
  if (!distiller) {
    return {
      supported: false,
      entries: [],
    };
  }

  const payloadBundle = loadEvidencePayloadWithText(evidenceRecord, { catalogRoot });
  const stableExtractedAt = extractedAt ?? evidenceRecord.captured_at ?? new Date().toISOString();
  const entries = dedupeEntries(distiller({
    evidenceRecord,
    payloadBundle,
    extractedAt: stableExtractedAt,
    extractedBy,
  }));

  return {
    supported: true,
    entries,
  };
}

const DISTILLERS = Object.freeze({
  chat: distillChatEntries,
  file: distillFileEntries,
  diff: distillDiffEntries,
  log: distillLogEntries,
});

function distillChatEntries({ evidenceRecord, payloadBundle, extractedAt, extractedBy }) {
  const payload = payloadBundle.payload;
  const messages = Array.isArray(payload?.messages) ? payload.messages : [];
  const entries = [];

  messages.forEach((message, index) => {
    if (typeof message?.text !== "string") {
      return;
    }

    const pathPrefix = `messages.${message.sequence ?? index + 1}.text`;
    entries.push(...extractInlineAssignmentsFromText({
      text: message.text,
      evidenceRecord,
      strategyId: STRATEGY_IDS.chat,
      extractedAt,
      extractedBy,
      pathPrefix,
    }));
    entries.push(...extractCodeBlockAssignments({
      text: message.text,
      evidenceRecord,
      strategyId: STRATEGY_IDS.chat,
      extractedAt,
      extractedBy,
      pathPrefix,
    }));
  });

  return entries;
}

function distillFileEntries({ evidenceRecord, payloadBundle, extractedAt, extractedBy }) {
  const { payload, rawText } = payloadBundle;
  const extension = getSourceLocatorExtension(evidenceRecord);
  const entries = [];

  if (typeof payload === "object" && payload !== null) {
    entries.push(...extractFromStructuredValue({
      value: payload,
      evidenceRecord,
      strategyId: STRATEGY_IDS.file,
      extractedAt,
      extractedBy,
      rawText,
    }));
  }

  if (typeof rawText === "string" && rawText.trim()) {
    entries.push(...extractTextByHint({
      text: rawText,
      formatHint: extension,
      evidenceRecord,
      strategyId: STRATEGY_IDS.file,
      extractedAt,
      extractedBy,
    }));
  }

  return entries;
}

function distillDiffEntries({ evidenceRecord, payloadBundle, extractedAt, extractedBy }) {
  const diffText = extractPrimaryText(payloadBundle.payload, payloadBundle.rawText);
  if (!diffText) {
    return [];
  }

  const entries = [];
  const lines = String(diffText).split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!/^[+-]/.test(line) || /^(---|\+\+\+)/.test(line)) {
      continue;
    }

    const observationKind = line.startsWith("+") ? "set" : "unset";
    const rawLine = line.slice(1);
    entries.push(...extractAssignmentEntriesFromLine({
      lineText: rawLine,
      lineNumber: index + 1,
      evidenceRecord,
      strategyId: STRATEGY_IDS.diff,
      extractedAt,
      extractedBy,
      observationKind,
      pathPrefix: "diff",
    }));
  }

  return chainSupersededEntries(entries);
}

function distillLogEntries({ evidenceRecord, payloadBundle, extractedAt, extractedBy }) {
  const entries = [];
  const { payload, rawText } = payloadBundle;

  if (typeof payload === "object" && payload !== null) {
    entries.push(...extractFromStructuredValue({
      value: payload,
      evidenceRecord,
      strategyId: STRATEGY_IDS.log,
      extractedAt,
      extractedBy,
      rawText,
    }));
  }

  const primaryText = extractPrimaryText(payload, rawText);
  if (!primaryText) {
    return dedupeEntries(entries);
  }

  const lines = String(primaryText).split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object") {
        entries.push(...extractFromStructuredValue({
          value: parsed,
          evidenceRecord,
          strategyId: STRATEGY_IDS.log,
          extractedAt,
          extractedBy,
          rawText: line,
          pathPrefix: `lines.${index + 1}`,
          lineOffset: index,
        }));
      }
      continue;
    } catch {
      // Fall through to explicit assignment parsing only.
    }

    entries.push(...extractAssignmentEntriesFromLine({
      lineText: line,
      lineNumber: index + 1,
      evidenceRecord,
      strategyId: STRATEGY_IDS.log,
      extractedAt,
      extractedBy,
      observationKind: "observed",
      pathPrefix: "logs",
    }));
  }

  return dedupeEntries(entries);
}

function extractCodeBlockAssignments({ text, evidenceRecord, strategyId, extractedAt, extractedBy, pathPrefix }) {
  const entries = [];
  const codeBlockPattern = /```([A-Za-z0-9_-]+)?\n([\s\S]*?)```/g;
  let match;
  while ((match = codeBlockPattern.exec(text)) !== null) {
    const formatHint = normalizeFormatHint(match[1]);
    const blockText = match[2];
    entries.push(...extractTextByHint({
      text: blockText,
      formatHint,
      evidenceRecord,
      strategyId,
      extractedAt,
      extractedBy,
      pathPrefix,
    }));
  }
  return entries;
}

function extractTextByHint({
  text,
  formatHint,
  evidenceRecord,
  strategyId,
  extractedAt,
  extractedBy,
  pathPrefix = "payload",
} = {}) {
  const normalizedHint = normalizeFormatHint(formatHint);
  if (normalizedHint === ".env") {
    return extractSimpleAssignments({
      text,
      evidenceRecord,
      strategyId,
      extractedAt,
      extractedBy,
      pathPrefix,
      observationKind: "set",
    });
  }

  if (normalizedHint === ".json") {
    try {
      const parsed = JSON.parse(text);
      return extractFromStructuredValue({
        value: parsed,
        evidenceRecord,
        strategyId,
        extractedAt,
        extractedBy,
        rawText: text,
        pathPrefix,
      });
    } catch {
      return [];
    }
  }

  if (normalizedHint === ".yaml" || normalizedHint === ".yml") {
    const parsedEntries = extractYamlAssignments({
      text,
      evidenceRecord,
      strategyId,
      extractedAt,
      extractedBy,
      pathPrefix,
    });
    if (parsedEntries.length > 0) {
      return parsedEntries;
    }

    try {
      const parsed = YAML.parse(text);
      return extractFromStructuredValue({
        value: parsed,
        evidenceRecord,
        strategyId,
        extractedAt,
        extractedBy,
        rawText: text,
        pathPrefix,
      });
    } catch {
      return [];
    }
  }

  if (normalizedHint === ".toml") {
    const parsedEntries = extractTomlAssignments({
      text,
      evidenceRecord,
      strategyId,
      extractedAt,
      extractedBy,
      pathPrefix,
    });
    if (parsedEntries.length > 0) {
      return parsedEntries;
    }

    try {
      const parsed = TOML.parse(text);
      return extractFromStructuredValue({
        value: parsed,
        evidenceRecord,
        strategyId,
        extractedAt,
        extractedBy,
        rawText: text,
        pathPrefix,
      });
    } catch {
      return [];
    }
  }

  return extractSimpleAssignments({
    text,
    evidenceRecord,
    strategyId,
    extractedAt,
    extractedBy,
    pathPrefix,
    observationKind: "set",
  });
}

function extractSimpleAssignments({
  text,
  evidenceRecord,
  strategyId,
  extractedAt,
  extractedBy,
  pathPrefix,
  observationKind,
} = {}) {
  const entries = [];
  const lines = String(text).split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    entries.push(...extractAssignmentEntriesFromLine({
      lineText: lines[index],
      lineNumber: index + 1,
      evidenceRecord,
      strategyId,
      extractedAt,
      extractedBy,
      observationKind,
      pathPrefix,
    }));
  }

  return entries;
}

function extractInlineAssignmentsFromText({
  text,
  evidenceRecord,
  strategyId,
  extractedAt,
  extractedBy,
  pathPrefix,
} = {}) {
  const entries = [];
  const lines = String(text).split(/\r?\n/);

  lines.forEach((line, index) => {
    entries.push(...extractAssignmentEntriesFromLine({
      lineText: line,
      lineNumber: index + 1,
      evidenceRecord,
      strategyId,
      extractedAt,
      extractedBy,
      observationKind: "observed",
      pathPrefix,
    }));
    entries.push(...extractVersionEntriesFromLine({
      lineText: line,
      lineNumber: index + 1,
      evidenceRecord,
      strategyId,
      extractedAt,
      extractedBy,
      pathPrefix,
    }));
  });

  return entries;
}

function extractAssignmentEntriesFromLine({
  lineText,
  lineNumber,
  evidenceRecord,
  strategyId,
  extractedAt,
  extractedBy,
  observationKind,
  pathPrefix,
} = {}) {
  const entries = [];
  const envMatch = lineText.match(/^\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.+?)\s*$/);
  if (envMatch) {
    const observedKey = envMatch[1];
    const value = parseScalarLiteral(envMatch[2]);
    const startChar = lineText.indexOf(observedKey);
    const entry = createEntry({
      observedKey,
      value,
      observationKind,
      evidenceRecord,
      strategyId,
      extractedAt,
      extractedBy,
      sourceSpan: lineSpan({
        path: `${pathPrefix}.${observedKey}`,
        lineNumber,
        lineText,
        startChar,
      }),
    });
    if (entry) {
      entries.push(entry);
    }
  }

  const cliPattern = /--([A-Za-z0-9_.-]+)=("[^"]*"|'[^']*'|[^\s,;]+)/g;
  let cliMatch;
  while ((cliMatch = cliPattern.exec(lineText)) !== null) {
    const observedKey = cliMatch[1];
    const value = parseScalarLiteral(cliMatch[2]);
    const entry = createEntry({
      observedKey,
      value,
      observationKind,
      evidenceRecord,
      strategyId,
      extractedAt,
      extractedBy,
      sourceSpan: lineSpan({
        path: `${pathPrefix}.${observedKey}`,
        lineNumber,
        lineText: cliMatch[0],
      }),
    });
    if (entry) {
      entries.push(entry);
    }
  }

  return entries;
}

function extractVersionEntriesFromLine({
  lineText,
  lineNumber,
  evidenceRecord,
  strategyId,
  extractedAt,
  extractedBy,
  pathPrefix,
} = {}) {
  const entries = [];
  const versionPatterns = [
    /\b([A-Za-z][A-Za-z0-9_.-]{1,40})@([0-9]+(?:\.[0-9A-Za-z-]+){1,})\b/g,
    /\b([A-Za-z][A-Za-z0-9_.-]{1,40})\s+(?:version|v)\s*([0-9]+(?:\.[0-9A-Za-z-]+){1,})\b/gi,
  ];

  for (const pattern of versionPatterns) {
    let match;
    while ((match = pattern.exec(lineText)) !== null) {
      const observedKey = `${match[1]}.version`;
      const value = match[2];
      const entry = createEntry({
        observedKey,
        value,
        observationKind: "observed",
        evidenceRecord,
        strategyId,
        extractedAt,
        extractedBy,
        toolBinding: [match[1]],
        sourceSpan: lineSpan({
          path: `${pathPrefix}.${observedKey}`,
          lineNumber,
          lineText: match[0],
        }),
      });
      if (entry) {
        entries.push(entry);
      }
    }
  }

  return entries;
}

function extractYamlAssignments({
  text,
  evidenceRecord,
  strategyId,
  extractedAt,
  extractedBy,
  pathPrefix,
} = {}) {
  const entries = [];
  const stack = [];
  const lines = String(text).split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const match = line.match(/^(\s*)([A-Za-z0-9_.-]+)\s*:\s*(.*?)\s*$/);
    if (!match) {
      continue;
    }

    const indent = match[1].length;
    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }

    const key = match[2];
    const valueText = match[3];
    const nextPath = [...stack.map((entry) => entry.key), key];

    if (!valueText) {
      stack.push({ key, indent });
      continue;
    }

    const value = parseScalarLiteral(valueText);
    const entry = createEntry({
      observedKey: nextPath.join("."),
      value,
      observationKind: "set",
      evidenceRecord,
      strategyId,
      extractedAt,
      extractedBy,
      sourceSpan: lineSpan({
        path: `${pathPrefix}.${nextPath.join(".")}`,
        lineNumber: index + 1,
        lineText: line,
      }),
    });
    if (entry) {
      entries.push(entry);
    }
  }

  return entries;
}

function extractTomlAssignments({
  text,
  evidenceRecord,
  strategyId,
  extractedAt,
  extractedBy,
  pathPrefix,
} = {}) {
  const entries = [];
  const lines = String(text).split(/\r?\n/);
  let section = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const sectionMatch = trimmed.match(/^\[([A-Za-z0-9_.-]+)\]$/);
    if (sectionMatch) {
      section = sectionMatch[1].split(".");
      continue;
    }

    const assignmentMatch = trimmed.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+?)\s*$/);
    if (!assignmentMatch) {
      continue;
    }

    const nextPath = [...section, assignmentMatch[1]];
    const value = parseScalarLiteral(assignmentMatch[2]);
    const entry = createEntry({
      observedKey: nextPath.join("."),
      value,
      observationKind: "set",
      evidenceRecord,
      strategyId,
      extractedAt,
      extractedBy,
      sourceSpan: lineSpan({
        path: `${pathPrefix}.${nextPath.join(".")}`,
        lineNumber: index + 1,
        lineText: line,
      }),
    });
    if (entry) {
      entries.push(entry);
    }
  }

  return entries;
}

function extractFromStructuredValue({
  value,
  evidenceRecord,
  strategyId,
  extractedAt,
  extractedBy,
  rawText,
  pathPrefix = "payload",
  currentPath = [],
  lineOffset = 0,
} = {}) {
  if (value == null) {
    return [];
  }

  if (Array.isArray(value)) {
    if (value.every(isScalar)) {
      return createEntryList({
        observedKey: currentPath.join("."),
        value,
        evidenceRecord,
        strategyId,
        extractedAt,
        extractedBy,
        observationKind: "observed",
        sourceSpan: findStructuredSourceSpan({
          rawText,
          pathSegments: currentPath,
          value,
          pathPrefix,
          lineOffset,
        }),
      });
    }

    return value.flatMap((entry, index) =>
      extractFromStructuredValue({
        value: entry,
        evidenceRecord,
        strategyId,
        extractedAt,
        extractedBy,
        rawText,
        pathPrefix,
        currentPath: [...currentPath, String(index)],
        lineOffset,
      }));
  }

  if (typeof value === "object") {
    const entries = [];
    for (const [key, nestedValue] of Object.entries(value)) {
      entries.push(...extractFromStructuredValue({
        value: nestedValue,
        evidenceRecord,
        strategyId,
        extractedAt,
        extractedBy,
        rawText,
        pathPrefix,
        currentPath: [...currentPath, key],
        lineOffset,
      }));
    }
    return entries;
  }

  return createEntryList({
    observedKey: currentPath.join("."),
    value,
    evidenceRecord,
    strategyId,
    extractedAt,
    extractedBy,
    observationKind: "observed",
    sourceSpan: findStructuredSourceSpan({
      rawText,
      pathSegments: currentPath,
      value,
      pathPrefix,
      lineOffset,
    }),
  });
}

function createEntryList(options) {
  const entry = createEntry(options);
  return entry ? [entry] : [];
}

function createEntry({
  observedKey,
  value,
  observationKind,
  evidenceRecord,
  strategyId,
  extractedAt,
  extractedBy,
  sourceSpan,
  toolBinding,
} = {}) {
  if (!observedKey || !isParameterLikeKey(observedKey, value)) {
    return null;
  }

  return {
    workspace_id: evidenceRecord.workspace_id ?? null,
    parameter_key: observedKey,
    raw_value_text: formatRawValueText(value),
    value_type: inferValueType(value),
    value_json: value,
    observation_kind: observationKind,
    observed_at: evidenceRecord.captured_at,
    project_scope: evidenceRecord.project_scope,
    source_evidence_refs: [evidenceRecord.evidence_id],
    source_spans: [sourceSpan],
    strategy_id: strategyId,
    extracted_at: extractedAt,
    extracted_by: extractedBy,
    confidence: confidenceForValue(value),
    tool_binding: toolBinding,
  };
}

function chainSupersededEntries(entries) {
  const grouped = new Map();
  for (const entry of entries) {
    const key = entry.parameter_key;
    if (!grouped.has(key)) {
      grouped.set(key, []);
    }
    grouped.get(key).push(entry);
  }

  for (const group of grouped.values()) {
    group.sort((left, right) =>
      left.source_spans[0].start_line - right.source_spans[0].start_line
      || left.source_spans[0].start_char - right.source_spans[0].start_char);

    for (let index = 1; index < group.length; index += 1) {
      const previous = group[index - 1];
      const current = group[index];
      current.supersedes_key = previous;
    }
  }

  return entries;
}

function dedupeEntries(entries) {
  return [...new Map(entries.map((entry) => [
    JSON.stringify({
      parameter_key: entry.parameter_key,
      observation_kind: entry.observation_kind,
      raw_value_text: entry.raw_value_text,
      source_spans: entry.source_spans,
    }),
    entry,
  ])).values()];
}

function extractPrimaryText(payload, rawText) {
  if (typeof payload === "string") {
    return payload;
  }

  if (payload && typeof payload === "object") {
    for (const key of ["text", "content", "diff", "patch", "body"]) {
      if (typeof payload[key] === "string") {
        return payload[key];
      }
    }
  }

  return typeof rawText === "string" ? rawText : null;
}

function isParameterLikeKey(observedKey, value) {
  const key = String(observedKey).trim();
  if (!key) {
    return false;
  }

  const lastSegment = key.split(".").at(-1);
  if (NON_PARAMETER_SEGMENTS.has(lastSegment.toLowerCase())) {
    return false;
  }

  if (typeof value === "string" && value.length > 400) {
    return false;
  }

  if (Array.isArray(value) && value.some((entry) => typeof entry === "object")) {
    return false;
  }

  if (/^[A-Z][A-Z0-9_.-]+$/.test(key)) {
    return true;
  }

  if (/(?:^|\.)(config|settings|env|options|params)\./i.test(key)) {
    return true;
  }

  return PARAMETER_NAME_PATTERN.test(lastSegment);
}

function confidenceForValue(value) {
  if (value === null) {
    return 0.84;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return 0.94;
  }

  if (Array.isArray(value) || typeof value === "object") {
    return 0.78;
  }

  return 0.88;
}

function findStructuredSourceSpan({ rawText, pathSegments, value, pathPrefix, lineOffset = 0 } = {}) {
  const pathLabel = `${pathPrefix}.${pathSegments.join(".")}`;
  if (!rawText) {
    return lineSpan({
      path: pathLabel,
      lineNumber: 1 + lineOffset,
      lineText: `${pathSegments.join(".")}: ${formatRawValueText(value)}`,
    });
  }

  const valueTokens = [
    formatRawValueText(value),
    JSON.stringify(value),
  ].filter(Boolean).map((entry) => String(entry));
  const lastKey = pathSegments.at(-1);
  const lines = String(rawText).split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.includes(lastKey)) {
      continue;
    }

    if (valueTokens.some((token) => token.length === 0 || line.includes(token))) {
      const startChar = Math.max(0, line.indexOf(lastKey));
      return lineSpan({
        path: pathLabel,
        lineNumber: index + 1 + lineOffset,
        lineText: line,
        startChar,
      });
    }
  }

  return lineSpan({
    path: pathLabel,
    lineNumber: 1 + lineOffset,
    lineText: `${pathSegments.join(".")}: ${formatRawValueText(value)}`,
  });
}

function normalizeFormatHint(value) {
  const lower = String(value ?? "").trim().toLowerCase();
  if (!lower) {
    return "";
  }

  if (["json", ".json"].includes(lower)) {
    return ".json";
  }
  if (["yaml", "yml", ".yaml", ".yml"].includes(lower)) {
    return ".yaml";
  }
  if (["toml", ".toml"].includes(lower)) {
    return ".toml";
  }
  if (["env", "dotenv", ".env"].includes(lower)) {
    return ".env";
  }

  return lower.startsWith(".") ? lower : lower;
}

function isScalar(value) {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

const PARAMETER_NAME_PATTERN = /(url|uri|path|dir|file|host|port|endpoint|model|version|timeout|limit|threshold|size|bucket|enabled|disabled|retries|retry|interval|ttl|collection|database|schema|organization|project|key)$/i;
const NON_PARAMETER_SEGMENTS = new Set([
  "objective",
  "findings",
  "blockers",
  "steps_completed",
  "messages",
  "message_count",
  "sequence",
  "role",
  "text",
  "summary",
  "rationale",
  "decision",
  "quote",
  "action",
  "outcome",
  "failure_mode",
]);

module.exports = {
  STRATEGY_IDS,
  distillParameterEntries,
};
