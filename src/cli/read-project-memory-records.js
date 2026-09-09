#!/usr/bin/env node

const path = require("node:path");
const { DEFAULT_CATALOG_ROOT } = require("../cases/case-refresh");
const { ProjectMemorySurface } = require("../runtime/project-memory");
const { readerError, validateSelection } = require("../runtime/project-memory-reader");
const { FileBackedCatalog } = require("../storage/file-backed-catalog");
const { resolveProjectMemoryConfig } = require("../workspace/project-memory-config");

function parseArgs(args) {
  const options = { workspaceRoot: null, workspaceId: null, catalogRoot: null, evidenceExcerpt: null };
  const seen = new Set();
  let evidenceId;
  let startLine;
  let endLine;
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[++index];
    if (seen.has(flag) || typeof value !== "string" || !value || value.startsWith("--")) throw readerError("invalid_reader_arguments");
    seen.add(flag);
    switch (flag) {
      case "--workspace-root": options.workspaceRoot = path.resolve(value); break;
      case "--workspace-id": options.workspaceId = value; break;
      case "--catalog-root": options.catalogRoot = path.resolve(value); break;
      case "--invocation-id": options.invocationId = value; break;
      case "--record-ids": options.recordIds = value.split(","); break;
      case "--evidence-id": evidenceId = value; break;
      case "--start-line":
        if (!/^[1-9][0-9]*$/.test(value)) throw readerError("invalid_excerpt_span");
        startLine = Number(value); break;
      case "--end-line":
        if (!/^[1-9][0-9]*$/.test(value)) throw readerError("invalid_excerpt_span");
        endLine = Number(value); break;
      default: throw readerError("unknown_reader_argument");
    }
  }
  if (!options.invocationId) throw readerError("missing_invocation_id");
  if (evidenceId !== undefined || startLine !== undefined || endLine !== undefined) {
    options.evidenceExcerpt = { recordId: evidenceId, startLine, endLine };
  }
  validateSelection(options);
  if (!options.workspaceRoot && !options.workspaceId) options.workspaceRoot = process.cwd();
  return options;
}

function main(args = process.argv.slice(2)) {
  const options = parseArgs(args);
  const resolved = resolveProjectMemoryConfig({ ...options, catalogRoot: options.catalogRoot ?? DEFAULT_CATALOG_ROOT });
  if (options.workspaceId && options.workspaceId !== resolved.projectConfig.workspace_id) throw readerError("invocation_workspace_mismatch");
  if (options.catalogRoot && options.catalogRoot !== resolved.projectConfig.catalog_root) throw readerError("invocation_catalog_mismatch");
  const surface = new ProjectMemorySurface({
    catalog: new FileBackedCatalog({ rootDir: resolved.projectConfig.catalog_root }),
    projectConfig: resolved.projectConfig,
    artifactRoot: resolved.artifactRoot,
  });
  const response = surface.readProjectMemoryRecords(options);
  // The runtime reserves and verifies this exact compact envelope before persisting the receipt.
  process.stdout.write(`${JSON.stringify(response)}\n`);
  return response;
}

if (require.main === module) {
  try { main(); }
  catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, error: /^[a-z][a-z0-9_]+$/.test(error.code ?? "") ? error.code : "reader_failed" })}\n`);
    process.exitCode = 1;
  }
}

module.exports = { main, parseArgs };
