#!/usr/bin/env node

const { buildSupportGraphDiff } = require("../support-graph/diff");
const { expandRelated, findShortestPath, listNeighbors } = require("../support-graph/query");
const { loadLatestDiff, loadSnapshot } = require("../support-graph/refresh");

function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command) {
    throw new Error("query-support-graph requires a command: neighbors, path, related, or diff.");
  }

  const options = parseArgs(rest);

  if (command === "diff" && !options.fromSnapshot && !options.toSnapshot) {
    const latestDiff = loadLatestDiff({ graphRoot: options.graphRoot });
    if (!latestDiff) {
      throw new Error("No support-graph diff is available yet.");
    }
    process.stdout.write(`${JSON.stringify(latestDiff, null, 2)}\n`);
    return;
  }

  const snapshot = loadSnapshot({
    snapshotPath: options.snapshotPath ?? options.toSnapshot,
    graphRoot: options.graphRoot,
  });

  if (!snapshot) {
    throw new Error("No support-graph snapshot is available yet.");
  }

  let result;
  switch (command) {
    case "neighbors":
      result = listNeighbors({
        snapshot,
        nodeId: options.recordId ?? options.nodeId,
        direction: options.direction ?? "both",
        projectScope: options.projectScope ?? null,
        nodeTypes: options.nodeTypes,
        limit: options.limit ?? 20,
      });
      break;
    case "path":
      result = findShortestPath({
        snapshot,
        from: options.from,
        to: options.to,
        projectScope: options.projectScope ?? null,
        maxDepth: options.maxDepth ?? 6,
      });
      break;
    case "related":
      result = expandRelated({
        snapshot,
        nodeId: options.recordId ?? options.nodeId,
        projectScope: options.projectScope ?? null,
        maxDepth: options.maxDepth ?? 2,
        limit: options.limit ?? 10,
        canonicalOnly: !options.includeSupportNodes,
      });
      break;
    case "diff":
      result = buildSupportGraphDiff({
        previousSnapshot: loadSnapshot({
          snapshotPath: options.fromSnapshot,
          graphRoot: options.graphRoot,
        }),
        nextSnapshot: snapshot,
        generatedAt: options.generatedAt,
      });
      break;
    default:
      throw new Error(`Unsupported support-graph query command: ${command}`);
  }

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

function parseArgs(args) {
  const options = {};

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--snapshot":
        options.snapshotPath = args[++index];
        break;
      case "--graph-root":
        options.graphRoot = args[++index];
        break;
      case "--record-id":
        options.recordId = args[++index];
        break;
      case "--node-id":
        options.nodeId = args[++index];
        break;
      case "--direction":
        options.direction = args[++index];
        break;
      case "--project-scope":
        options.projectScope = args[++index];
        break;
      case "--node-types":
        options.nodeTypes = args[++index].split(",").map((entry) => entry.trim()).filter(Boolean);
        break;
      case "--limit":
        options.limit = Number.parseInt(args[++index], 10);
        break;
      case "--max-depth":
        options.maxDepth = Number.parseInt(args[++index], 10);
        break;
      case "--from":
        options.from = args[++index];
        break;
      case "--to":
        options.to = args[++index];
        break;
      case "--from-snapshot":
        options.fromSnapshot = args[++index];
        break;
      case "--to-snapshot":
        options.toSnapshot = args[++index];
        break;
      case "--generated-at":
        options.generatedAt = args[++index];
        break;
      case "--include-support-nodes":
        options.includeSupportNodes = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
