const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { TextDecoder } = require("node:util");
const { REPO_ROOT } = require("../validation/schema-registry");
const { readerError } = require("./project-memory-reader");

const DEFAULT_SOURCE_MAP_PATH = path.join(REPO_ROOT, "config", "workspace-source-map.json");
const SOURCE_LIMIT_BYTES = 1024 * 1024;
const SESSION_REF = /^memory\/sessions\/\d{4}\/(?:0[1-9]|1[0-2])\/(session_[A-Za-z0-9_-]+)\.json$/;
const RUN_REF = /^memory\/runs\/\d{4}\/(?:0[1-9]|1[0-2])\/(run_[A-Za-z0-9_-]+)\.json$/;
const text = (value, limit = 1024) => typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= limit;
const fail = (reason, status = "invalid") => { throw Object.assign(new Error(reason), { reason, status }); };
const sameFile = (left, right) => ["dev", "ino", "size", "mtimeMs", "ctimeMs"].every((key) => left[key] === right[key]);

function readSource(filePath, kind, ownerRoot = null) {
  let descriptor;
  try {
    const resolved = path.resolve(filePath);
    const real = fs.realpathSync(resolved);
    // Reject path aliases as well as a symlink at the final component.
    if (real !== resolved) fail(`${kind}_path_not_canonical`);
    if (ownerRoot) {
      const relative = path.relative(ownerRoot, real);
      if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) fail(`${kind}_outside_owner_root`);
    }
    descriptor = fs.openSync(real, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const before = fs.fstatSync(descriptor);
    if (!before.isFile()) fail(`${kind}_not_regular`);
    if (before.size > SOURCE_LIMIT_BYTES) fail(`${kind}_input_budget_exceeded`);
    const buffer = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = fs.readSync(descriptor, buffer, length, buffer.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length !== before.size || !sameFile(before, fs.fstatSync(descriptor))
      || !sameFile(before, fs.lstatSync(real)) || fs.realpathSync(resolved) !== real) {
      fail(`${kind}_source_changed`, "unresolved");
    }
    const bytes = buffer.subarray(0, length);
    let data;
    try { data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
    catch { fail(`${kind}_invalid_json`); }
    if (!data || typeof data !== "object" || Array.isArray(data)) fail(`${kind}_invalid_shape`);
    return { ref: resolved, sha256: crypto.createHash("sha256").update(bytes).digest("hex"), data, kind, ownerRoot };
  } catch (error) {
    if (error.reason) throw error;
    if (["ELOOP"].includes(error.code)) fail(`${kind}_path_not_canonical`);
    fail(`${kind}_unavailable`, "unresolved");
  } finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
}

function inspectEpisodeAttribution({ projectConfig, context = {}, now, sourceMapPath = DEFAULT_SOURCE_MAP_PATH }) {
  const result = {
    status: "absent", reason: "session_ref_not_supplied", checked_at: now.toISOString(),
    task_project_id: null, retrieval_workspace_id: projectConfig.workspace_id, workspace_relation: null,
    source_map: null, registry: null, session: null, run: null,
  };
  if (context.session_ref == null) return result;
  const snapshots = [];
  const inspect = (filePath, kind, root) => {
    const source = readSource(filePath, kind, root);
    snapshots.push(source);
    return source;
  };
  try {
    const sessionMatch = SESSION_REF.exec(context.session_ref);
    if (!sessionMatch) fail("session_ref_not_canonical");
    const sourceMap = inspect(sourceMapPath, "source_map");
    result.source_map = { ref: sourceMap.ref, sha256: sourceMap.sha256 };
    const configuredRegistry = sourceMap.data.agent_ops_registry_path ?? process.env.AGENT_OPS_PROJECT_REGISTRY;
    if (!text(configuredRegistry)) fail("owner_registry_not_configured", "unresolved");
    const registryPath = path.resolve(path.dirname(sourceMap.ref), configuredRegistry);
    if (path.basename(registryPath) !== "_registry.json" || path.basename(path.dirname(registryPath)) !== "projects"
      || path.basename(path.dirname(path.dirname(registryPath))) !== "memory") fail("owner_registry_layout_invalid");
    const registry = inspect(registryPath, "registry");
    result.registry = { ref: registry.ref, sha256: registry.sha256 };
    if (!Array.isArray(registry.data.projects)) fail("registry_invalid_shape");
    const ownerRoot = path.dirname(path.dirname(path.dirname(registryPath)));
    const sessionSource = inspect(path.join(ownerRoot, context.session_ref), "session", ownerRoot);
    const session = sessionSource.data;
    if (session.id !== sessionMatch[1] || !text(session.project_id, 160)
      || (session.thread_ref != null && !text(session.thread_ref))) fail("session_identity_invalid");
    const registered = registry.data.projects.filter((entry) => entry?.id === session.project_id);
    if (registered.length !== 1) fail(registered.length ? "session_project_ambiguous" : "session_project_not_registered");
    result.session = { ref: context.session_ref, id: session.id, project_id: session.project_id,
      thread_ref: session.thread_ref ?? null, sha256: sessionSource.sha256 };
    result.task_project_id = session.project_id;
    result.workspace_relation = session.project_id === projectConfig.workspace_id ? "same_workspace" : "cross_workspace";
    if (context.thread_ref != null) {
      if (session.thread_ref == null) fail("session_thread_ref_unavailable", "unresolved");
      if (context.thread_ref !== session.thread_ref) fail("session_thread_ref_conflict");
    }
    if (context.task_workspace_relation != null && context.task_workspace_relation !== result.workspace_relation) {
      fail("task_workspace_relation_conflict");
    }
    if (result.workspace_relation === "cross_workspace" && context.task_workspace_relation !== "cross_workspace") {
      fail("cross_workspace_relation_not_declared", "unresolved");
    }
    if (context.run_ref != null) {
      const runMatch = RUN_REF.exec(context.run_ref);
      if (!runMatch) fail("run_ref_not_canonical");
      const runSource = inspect(path.join(ownerRoot, context.run_ref), "run", ownerRoot);
      const run = runSource.data;
      if (run.id !== runMatch[1] || run.project_id !== session.project_id || run.session_ref !== context.session_ref
        || (run.thread_ref != null && !text(run.thread_ref))) fail("run_identity_conflict");
      if (session.run_ref == null) fail("session_run_ref_unavailable", "unresolved");
      if (session.run_ref !== context.run_ref) fail("session_run_ref_conflict");
      if (run.thread_ref != null && session.thread_ref != null && run.thread_ref !== session.thread_ref) fail("run_thread_ref_conflict");
      result.run = { ref: context.run_ref, id: run.id, project_id: run.project_id, session_ref: run.session_ref,
        thread_ref: run.thread_ref ?? null, sha256: runSource.sha256 };
    }
    // The inspected sources form one stable capture, not an authority that can
    // survive changes while this inspection itself is still in progress.
    for (const snapshot of snapshots) {
      if (readSource(snapshot.ref, snapshot.kind, snapshot.ownerRoot).sha256 !== snapshot.sha256) {
        fail(`${snapshot.kind}_source_changed`, "unresolved");
      }
    }
    result.status = "verified";
    result.reason = null;
  } catch (error) {
    result.status = error.status ?? "unresolved";
    result.reason = error.reason ?? "source_inspection_unavailable";
  }
  return result;
}

function assertOpportunityContext({ artifact, projectConfig, taskPacket, context, inspected }) {
  const old = artifact.telemetry?.opportunity;
  if (!old) throw readerError("opportunity_context_unavailable");
  const expected = { workspace_id: projectConfig.workspace_id, workspace_root: projectConfig.workspace_root,
    catalog_root: projectConfig.catalog_root, task_id: taskPacket?.task_id ?? null };
  for (const [key, value] of Object.entries(expected)) {
    if (old.binding[key] !== value) throw readerError("opportunity_context_conflict");
  }
  for (const key of ["episode_id", "session_ref", "thread_ref", "task_workspace_relation"]) {
    if (context[key] != null && context[key] !== (old.binding[key] ?? null)) {
      throw readerError("opportunity_context_conflict");
    }
  }
  if (context.run_ref != null && old.binding.run_ref != null && context.run_ref !== old.binding.run_ref) {
    throw readerError("opportunity_context_conflict");
  }
  if (context.run_ref != null && old.binding.run_ref == null && inspected?.status !== "verified") {
    throw readerError("opportunity_run_ref_unverified");
  }
  const previousSession = old.attribution?.session;
  const currentSession = inspected?.session;
  if (previousSession && currentSession && ["ref", "id", "project_id", "thread_ref"].some((key) => previousSession[key] !== currentSession[key])) {
    throw readerError("opportunity_session_identity_changed");
  }
  // Capture hashes and a later reciprocal run are intentionally not rebound.
}

module.exports = { inspectEpisodeAttribution, assertOpportunityContext, DEFAULT_SOURCE_MAP_PATH, SOURCE_LIMIT_BYTES, SESSION_REF, RUN_REF };
