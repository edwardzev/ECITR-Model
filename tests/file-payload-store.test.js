const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { FilePayloadStore, createSha256 } = require("../src/evidence/file-payload-store");

test("file payload store writes stable refs and hashes", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-payloads-"));
  const store = new FilePayloadStore({ rootDir });
  const bytes = Buffer.from("{\"ok\":true}\n", "utf8");

  const result = store.writePayload({
    evidenceId: "ev_aops_run_run_20260410_example",
    capturedAt: "2026-04-10T17:34:34.209Z",
    extension: ".json",
    namespaceSegments: ["agent-ops", "runs"],
    bytes,
  });

  assert.equal(
    result.relativeRef,
    "payloads/evidence/agent-ops/runs/2026/04/ev_aops_run_run_20260410_example.json",
  );
  assert.equal(result.payloadHash, createSha256(bytes));
  assert.equal(fs.readFileSync(result.absolutePath, "utf8"), bytes.toString("utf8"));
});

test("file payload store treats identical rewrites as no-op and blocks conflicting bytes", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecitr-payloads-"));
  const store = new FilePayloadStore({ rootDir });
  const firstBytes = Buffer.from("{\"run\":1}\n", "utf8");
  const secondBytes = Buffer.from("{\"run\":2}\n", "utf8");
  const payload = {
    evidenceId: "ev_aops_run_run_20260410_idempotent",
    capturedAt: "2026-04-10T17:34:34.209Z",
    extension: ".json",
    namespaceSegments: ["agent-ops", "runs"],
  };

  const firstWrite = store.writePayload({ ...payload, bytes: firstBytes });
  const secondWrite = store.writePayload({ ...payload, bytes: firstBytes });

  assert.equal(firstWrite.written, true);
  assert.equal(secondWrite.written, false);
  assert.throws(() => store.writePayload({ ...payload, bytes: secondBytes }));
});
