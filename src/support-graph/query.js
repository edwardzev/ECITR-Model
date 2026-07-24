const {
  confidenceRank,
  isCanonicalNodeType,
} = require("./types");

function resolveNodeId(snapshot, value) {
  const candidate = String(value).trim();
  const direct = (snapshot.nodes ?? []).find((node) => node.node_id === candidate);
  if (direct) {
    return direct.node_id;
  }

  const matches = (snapshot.nodes ?? []).filter((node) => node.record_id === candidate);
  if (matches.length === 1) {
    return matches[0].node_id;
  }

  if (matches.length > 1) {
    throw new Error(`Support graph query is ambiguous for record id: ${candidate}. Use an explicit node id.`);
  }

  throw new Error(`Support graph node not found: ${candidate}`);
}

function listNeighbors({
  snapshot,
  nodeId,
  direction = "both",
  projectScope = null,
  workspaceId = null,
  nodeTypes = null,
  limit = 20,
} = {}) {
  const resolvedNodeId = resolveNodeId(snapshot, nodeId);
  const { nodeIndex, edgeIndex, adjacency } = buildIndexes(snapshot);
  const result = [];

  for (const edgeId of adjacency.get(resolvedNodeId) ?? []) {
    const edge = edgeIndex.get(edgeId);
    const outgoing = edge.from === resolvedNodeId;
    if (direction === "outgoing" && !outgoing) {
      continue;
    }
    if (direction === "incoming" && outgoing) {
      continue;
    }

    const neighborNodeId = outgoing ? edge.to : edge.from;
    const neighbor = nodeIndex.get(neighborNodeId);
    if (!neighbor) {
      continue;
    }
    if (!matchesScope(projectScope, neighbor.project_scope) || !matchesScope(projectScope, edge.project_scope)) {
      continue;
    }
    if (!matchesWorkspace(workspaceId, neighbor.workspace_id)) {
      continue;
    }
    if (Array.isArray(nodeTypes) && nodeTypes.length > 0 && !nodeTypes.includes(neighbor.node_type)) {
      continue;
    }

    result.push({
      direction: outgoing ? "outgoing" : "incoming",
      edge,
      node: neighbor,
    });
  }

  return result
    .sort((left, right) =>
      confidenceRank(right.edge.confidence_label) - confidenceRank(left.edge.confidence_label)
      || left.node.node_type.localeCompare(right.node.node_type)
      || left.node.node_id.localeCompare(right.node.node_id))
    .slice(0, limit);
}

function findShortestPath({
  snapshot,
  from,
  to,
  projectScope = null,
  workspaceId = null,
  maxDepth = 6,
} = {}) {
  const fromNodeId = resolveNodeId(snapshot, from);
  const toNodeId = resolveNodeId(snapshot, to);
  if (fromNodeId === toNodeId) {
    return {
      node_path: [fromNodeId],
      edge_path: [],
      steps: [],
    };
  }

  const { nodeIndex, edgeIndex, adjacency } = buildIndexes(snapshot);
  const queue = [{ nodeId: fromNodeId, depth: 0 }];
  const visited = new Set([fromNodeId]);
  const previous = new Map();

  while (queue.length > 0) {
    const current = queue.shift();
    if (current.depth >= maxDepth) {
      continue;
    }

    for (const edgeId of adjacency.get(current.nodeId) ?? []) {
      const edge = edgeIndex.get(edgeId);
      if (!matchesScope(projectScope, edge.project_scope)) {
        continue;
      }

      const nextNodeId = edge.from === current.nodeId ? edge.to : edge.from;
      const nextNode = nodeIndex.get(nextNodeId);
      if (
        !nextNode
        || !matchesScope(projectScope, nextNode.project_scope)
        || !matchesWorkspace(workspaceId, nextNode.workspace_id)
        || visited.has(nextNodeId)
      ) {
        continue;
      }

      visited.add(nextNodeId);
      previous.set(nextNodeId, {
        nodeId: current.nodeId,
        edgeId,
      });

      if (nextNodeId === toNodeId) {
        return materializePath({ fromNodeId, toNodeId, previous, edgeIndex });
      }

      queue.push({ nodeId: nextNodeId, depth: current.depth + 1 });
    }
  }

  return null;
}

function expandRelated({
  snapshot,
  nodeId,
  projectScope = null,
  workspaceId = null,
  maxDepth = 2,
  limit = 10,
  canonicalOnly = true,
} = {}) {
  const resolvedNodeId = resolveNodeId(snapshot, nodeId);
  const { nodeIndex, edgeIndex, adjacency } = buildIndexes(snapshot);
  const queue = [{ nodeId: resolvedNodeId, depth: 0 }];
  const visitedDepth = new Map([[resolvedNodeId, 0]]);
  const predecessor = new Map();
  const supportCounts = new Map();

  while (queue.length > 0) {
    const current = queue.shift();
    if (current.depth >= maxDepth) {
      continue;
    }

    for (const edgeId of adjacency.get(current.nodeId) ?? []) {
      const edge = edgeIndex.get(edgeId);
      if (!matchesScope(projectScope, edge.project_scope)) {
        continue;
      }

      const nextNodeId = edge.from === current.nodeId ? edge.to : edge.from;
      const nextNode = nodeIndex.get(nextNodeId);
      if (
        !nextNode
        || !matchesScope(projectScope, nextNode.project_scope)
        || !matchesWorkspace(workspaceId, nextNode.workspace_id)
      ) {
        continue;
      }

      supportCounts.set(nextNodeId, (supportCounts.get(nextNodeId) ?? 0) + 1);
      const nextDepth = current.depth + 1;
      const existingDepth = visitedDepth.get(nextNodeId);

      if (existingDepth == null || nextDepth < existingDepth) {
        visitedDepth.set(nextNodeId, nextDepth);
        predecessor.set(nextNodeId, {
          nodeId: current.nodeId,
          edgeId,
        });
        queue.push({ nodeId: nextNodeId, depth: nextDepth });
      }
    }
  }

  return [...visitedDepth.entries()]
    .filter(([candidateNodeId]) => candidateNodeId !== resolvedNodeId)
    .map(([candidateNodeId, distance]) => {
      const node = nodeIndex.get(candidateNodeId);
      if (canonicalOnly && !isCanonicalNodeType(node.node_type)) {
        return null;
      }

      const examplePath = materializePath({
        fromNodeId: resolvedNodeId,
        toNodeId: candidateNodeId,
        previous: predecessor,
        edgeIndex,
      });

      const pathConfidence = examplePath.steps.reduce((max, step) =>
        Math.max(max, confidenceRank(step.confidence_label)), 0);

      return {
        node,
        distance,
        support_count: supportCounts.get(candidateNodeId) ?? 0,
        score: ((maxDepth + 1 - distance) * 100)
          + (isCanonicalNodeType(node.node_type) ? 15 : 0)
          + ((supportCounts.get(candidateNodeId) ?? 0) * 5)
          + pathConfidence,
        example_path: examplePath,
      };
    })
    .filter(Boolean)
    .sort((left, right) =>
      right.score - left.score
      || left.node.node_type.localeCompare(right.node.node_type)
      || left.node.node_id.localeCompare(right.node.node_id))
    .slice(0, limit);
}

function buildIndexes(snapshot) {
  const nodeIndex = new Map((snapshot.nodes ?? []).map((node) => [node.node_id, node]));
  const edgeIndex = new Map((snapshot.edges ?? []).map((edge) => [edge.edge_id, edge]));
  const adjacency = new Map();

  for (const edge of snapshot.edges ?? []) {
    append(adjacency, edge.from, edge.edge_id);
    append(adjacency, edge.to, edge.edge_id);
  }

  return {
    nodeIndex,
    edgeIndex,
    adjacency,
  };
}

function materializePath({ fromNodeId, toNodeId, previous, edgeIndex }) {
  const nodePath = [toNodeId];
  const edgePath = [];
  const steps = [];

  let cursor = toNodeId;
  while (cursor !== fromNodeId) {
    const link = previous.get(cursor);
    if (!link) {
      break;
    }

    const edge = edgeIndex.get(link.edgeId);
    edgePath.push(edge.edge_id);
    steps.push({
      from: link.nodeId,
      to: cursor,
      edge_id: edge.edge_id,
      kind: edge.kind,
      confidence_label: edge.confidence_label,
    });
    nodePath.push(link.nodeId);
    cursor = link.nodeId;
  }

  nodePath.reverse();
  edgePath.reverse();
  steps.reverse();

  return {
    node_path: nodePath,
    edge_path: edgePath,
    steps,
  };
}

function append(map, key, value) {
  if (!map.has(key)) {
    map.set(key, []);
  }
  map.get(key).push(value);
}

function matchesScope(requestedScope, value) {
  if (!requestedScope || requestedScope === "global") {
    return true;
  }

  return value === "global" || value === requestedScope;
}

function matchesWorkspace(requestedWorkspaceId, value) {
  if (!requestedWorkspaceId) {
    return true;
  }

  return value === requestedWorkspaceId;
}

module.exports = {
  expandRelated,
  findShortestPath,
  listNeighbors,
  resolveNodeId,
};
