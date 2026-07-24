const fs = require("node:fs");
const path = require("node:path");

const { EcitrValidator, readJson } = require("../validation/validator");

const WORKSPACE_MARKER_FILENAME = "ecitr.project.json";

function loadEcitrProjectConfig({ startDir, filePath, validator = new EcitrValidator() } = {}) {
  const markerPath = filePath
    ? path.resolve(filePath)
    : findWorkspaceMarker({ startDir });

  if (!markerPath) {
    return null;
  }

  const value = readJson(markerPath);
  validator.validateRecord("ecitr_project", value);

  const workspaceRoot = path.dirname(markerPath);
  return {
    ...value,
    marker_path: markerPath,
    workspace_root: workspaceRoot,
    catalog_root: path.resolve(workspaceRoot, value.catalog_root),
  };
}

function findWorkspaceMarker({ startDir } = {}) {
  if (!startDir) {
    return null;
  }

  let current = path.resolve(startDir);
  while (true) {
    const candidate = path.join(current, WORKSPACE_MARKER_FILENAME);
    if (fs.existsSync(candidate)) {
      return candidate;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

function assertCatalogRootMatches({ projectConfig, catalogRoot }) {
  const resolvedCatalogRoot = path.resolve(catalogRoot);
  if (projectConfig.catalog_root !== resolvedCatalogRoot) {
    throw new Error(
      `Workspace marker catalog_root ${projectConfig.catalog_root} does not match catalog root ${resolvedCatalogRoot}.`,
    );
  }
}

function resolveWorkspaceId({ workspaceId = null, catalogRoot = null } = {}) {
  if (workspaceId != null && workspaceId !== "") {
    return String(workspaceId).trim();
  }

  if (!catalogRoot) {
    return null;
  }

  return loadEcitrProjectConfig({ startDir: catalogRoot })?.workspace_id ?? null;
}

module.exports = {
  WORKSPACE_MARKER_FILENAME,
  assertCatalogRootMatches,
  findWorkspaceMarker,
  loadEcitrProjectConfig,
  resolveWorkspaceId,
};
