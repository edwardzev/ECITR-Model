const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const { REPO_ROOT } = require("../validation/schema-registry");
const { EcitrValidator } = require("../validation/validator");

class AtomicClaimExtractor {
  constructor({ validator = new EcitrValidator(), now = defaultNow } = {}) {
    this.validator = validator;
    this.now = now;
  }

  compile(packet) {
    this.validator.validateRecord("atomic_claim_extraction_packet", packet);

    const sourceText = resolveSourceText(packet);
    const extractedAt = packet.extracted_at ?? this.now();
    const claims = extractClaims({
      extractionId: packet.extraction_id,
      sourceText,
      maxClaims: packet.max_claims ?? 8,
    });

    const claimSet = {
      claim_set_id: packet.proposed_claim_set_id ?? createClaimSetId(packet.extraction_id),
      evidence_id: packet.evidence_id,
      source_hash: createSourceHash(sourceText),
      extracted_at: extractedAt,
      extracted_by: packet.extracted_by,
      strategy_id: packet.strategy_id,
      claims,
    };

    this.validator.validateRecord("atomic_claim_set", claimSet);
    return claimSet;
  }
}

function resolveSourceText(packet) {
  if (packet.source_text) {
    return packet.source_text;
  }

  const resolvedPath = path.isAbsolute(packet.source_text_path)
    ? packet.source_text_path
    : path.join(REPO_ROOT, packet.source_text_path);

  return fs.readFileSync(resolvedPath, "utf8");
}

function extractClaims({ extractionId, sourceText, maxClaims }) {
  const claims = [];
  const lines = String(sourceText).split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const originalLine = lines[index];
    const line = originalLine.trim();
    if (!line) {
      continue;
    }

    const startChar = originalLine.indexOf(line);
    const endChar = startChar + line.length;
    claims.push({
      claim_id: createClaimId(extractionId, claims.length),
      text: line,
      kind: inferClaimKind(line),
      confidence: inferConfidence(line),
      source_spans: [
        {
          start_line: index + 1,
          end_line: index + 1,
          start_char: startChar,
          end_char: endChar,
          quote: line,
        },
      ],
    });

    if (claims.length >= maxClaims) {
      break;
    }
  }

  if (claims.length === 0) {
    throw new Error("Atomic claim extraction produced no claims.");
  }

  return claims;
}

function inferClaimKind(text) {
  const normalized = text.toLowerCase();

  if (/\bmust\b|\bnever\b|\brequired\b|\bshould\b/.test(normalized)) {
    return "constraint";
  }

  if (/\bbecause\b|\btherefore\b|\bso that\b/.test(normalized)) {
    return "rationale";
  }

  if (/\bmove\b|\bapply\b|\bfilter\b|\breject\b|\buse\b/.test(normalized)) {
    return "decision";
  }

  if (/\bfailed\b|\ballows\b|\breturned\b|\bhappened\b|\bobserved\b/.test(normalized)) {
    return "observation";
  }

  return "fact";
}

function inferConfidence(text) {
  const kind = inferClaimKind(text);

  switch (kind) {
    case "constraint":
      return 0.9;
    case "rationale":
      return 0.82;
    case "decision":
      return 0.84;
    case "observation":
      return 0.8;
    default:
      return 0.76;
  }
}

function createClaimSetId(extractionId) {
  return `claimset_${hashText(extractionId).slice(0, 16)}`;
}

function createClaimId(extractionId, index) {
  return `claim_${hashText(`${extractionId}:${index}`).slice(0, 16)}`;
}

function createSourceHash(sourceText) {
  return `sha256:${hashText(sourceText)}`;
}

function hashText(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function defaultNow() {
  return new Date().toISOString();
}

module.exports = {
  AtomicClaimExtractor,
  extractClaims,
  inferClaimKind,
  createSourceHash,
};
