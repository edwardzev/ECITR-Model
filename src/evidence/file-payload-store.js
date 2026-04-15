const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const DEFAULT_BASE_SEGMENTS = Object.freeze(["payloads", "evidence"]);

class FilePayloadStore {
  constructor({ rootDir, baseSegments = DEFAULT_BASE_SEGMENTS }) {
    if (!rootDir) {
      throw new Error("FilePayloadStore requires a rootDir.");
    }

    this.rootDir = path.resolve(rootDir);
    this.baseSegments = normalizePathSegments(baseSegments, "baseSegments");
  }

  planPayload({ evidenceId, capturedAt, extension = "", namespaceSegments = [], bytes }) {
    assertEvidenceId(evidenceId);
    const normalizedBytes = toBuffer(bytes);
    const { year, month } = getDateParts(capturedAt);
    const normalizedExtension = normalizeExtension(extension);
    const normalizedNamespace = normalizePathSegments(namespaceSegments, "namespaceSegments");
    const relativeRef = path.posix.join(
      ...this.baseSegments,
      ...normalizedNamespace,
      year,
      month,
      `${evidenceId}${normalizedExtension}`,
    );

    return {
      relativeRef,
      absolutePath: path.join(this.rootDir, ...relativeRef.split("/")),
      payloadHash: createSha256(normalizedBytes),
      sizeBytes: normalizedBytes.length,
    };
  }

  writePayload({ evidenceId, capturedAt, extension = "", namespaceSegments = [], bytes, overwrite = false }) {
    const normalizedBytes = toBuffer(bytes);
    const planned = this.planPayload({
      evidenceId,
      capturedAt,
      extension,
      namespaceSegments,
      bytes: normalizedBytes,
    });

    fs.mkdirSync(path.dirname(planned.absolutePath), { recursive: true });

    if (fs.existsSync(planned.absolutePath)) {
      const existingBytes = fs.readFileSync(planned.absolutePath);
      const existingHash = createSha256(existingBytes);

      if (existingHash === planned.payloadHash) {
        return {
          ...planned,
          written: false,
        };
      }

      if (!overwrite) {
        throw new Error(`Payload already exists with different content: ${planned.relativeRef}`);
      }
    }

    fs.writeFileSync(planned.absolutePath, normalizedBytes);

    return {
      ...planned,
      written: true,
    };
  }
}

function createSha256(value) {
  return `sha256:${crypto.createHash("sha256").update(toBuffer(value)).digest("hex")}`;
}

function assertEvidenceId(evidenceId) {
  if (!evidenceId || typeof evidenceId !== "string") {
    throw new Error("FilePayloadStore requires a non-empty evidenceId.");
  }
}

function getDateParts(capturedAt) {
  if (!capturedAt || typeof capturedAt !== "string") {
    throw new Error("FilePayloadStore requires capturedAt as an ISO 8601 string.");
  }

  const capturedDate = new Date(capturedAt);
  if (Number.isNaN(capturedDate.getTime())) {
    throw new Error(`Invalid capturedAt value: ${capturedAt}`);
  }

  return {
    year: String(capturedDate.getUTCFullYear()),
    month: String(capturedDate.getUTCMonth() + 1).padStart(2, "0"),
  };
}

function normalizeExtension(extension) {
  if (!extension) {
    return "";
  }

  return extension.startsWith(".") ? extension : `.${extension}`;
}

function normalizePathSegments(segments, fieldName) {
  if (!Array.isArray(segments)) {
    throw new Error(`FilePayloadStore ${fieldName} must be an array.`);
  }

  return segments.map((segment) => {
    if (!segment || typeof segment !== "string") {
      throw new Error(`FilePayloadStore ${fieldName} entries must be non-empty strings.`);
    }

    if (segment.includes("/") || segment.includes("\\")) {
      throw new Error(`FilePayloadStore ${fieldName} entries must not contain path separators.`);
    }

    return segment;
  });
}

function toBuffer(value) {
  if (Buffer.isBuffer(value)) {
    return value;
  }

  if (value instanceof Uint8Array) {
    return Buffer.from(value);
  }

  if (typeof value === "string") {
    return Buffer.from(value, "utf8");
  }

  throw new Error("FilePayloadStore requires bytes as a Buffer, Uint8Array, or string.");
}

module.exports = {
  FilePayloadStore,
  DEFAULT_BASE_SEGMENTS,
  createSha256,
};
