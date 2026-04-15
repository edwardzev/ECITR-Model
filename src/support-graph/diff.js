const {
  CANONICAL_NODE_TYPES,
  DIFF_SCHEMA_VERSION,
  createDiffId,
  createFingerprint,
} = require("./types");

function buildSupportGraphDiff({
  previousSnapshot,
  nextSnapshot,
  generatedAt = new Date().toISOString(),
} = {}) {
  if (!previousSnapshot || !nextSnapshot) {
    throw new Error("buildSupportGraphDiff requires previousSnapshot and nextSnapshot.");
  }

  const previousNodes = indexBy(previousSnapshot.nodes ?? [], "node_id");
  const nextNodes = indexBy(nextSnapshot.nodes ?? [], "node_id");
  const previousEdges = indexBy(previousSnapshot.edges ?? [], "edge_id");
  const nextEdges = indexBy(nextSnapshot.edges ?? [], "edge_id");

  const addedNodes = difference(nextNodes, previousNodes);
  const removedNodes = difference(previousNodes, nextNodes);
  const addedEdges = difference(nextEdges, previousEdges);
  const removedEdges = difference(previousEdges, nextEdges);

  const changedEdges = [];
  for (const [edgeId, nextEdge] of nextEdges.entries()) {
    const previousEdge = previousEdges.get(edgeId);
    if (!previousEdge) {
      continue;
    }

    if (!edgesEquivalent(previousEdge, nextEdge)) {
      changedEdges.push({
        edge_id: edgeId,
        before: projectEdge(previousEdge),
        after: projectEdge(nextEdge),
      });
    }
  }

  const changedNeighborhoods = buildChangedNeighborhoods({
    previousSnapshot,
    nextSnapshot,
    addedEdges,
    removedEdges,
  });

  const summary = {
    added_nodes: addedNodes.length,
    removed_nodes: removedNodes.length,
    added_edges: addedEdges.length,
    removed_edges: removedEdges.length,
    changed_edges: changedEdges.length,
    changed_neighborhoods: changedNeighborhoods.length,
  };

  const fingerprint = createFingerprint({
    previous_build_id: previousSnapshot.build_id,
    next_build_id: nextSnapshot.build_id,
    addedNodes,
    removedNodes,
    addedEdges,
    removedEdges,
    changedEdges,
    changedNeighborhoods,
  });

  return {
    schema_version: DIFF_SCHEMA_VERSION,
    diff_id: createDiffId({
      previousBuildId: previousSnapshot.build_id,
      nextBuildId: nextSnapshot.build_id,
    }),
    generated_at: generatedAt,
    previous_snapshot_build_id: previousSnapshot.build_id,
    next_snapshot_build_id: nextSnapshot.build_id,
    fingerprint,
    summary,
    added_nodes: addedNodes.map(projectNode),
    removed_nodes: removedNodes.map(projectNode),
    added_edges: addedEdges.map(projectEdge),
    removed_edges: removedEdges.map(projectEdge),
    changed_edges: changedEdges,
    changed_neighborhoods: changedNeighborhoods,
  };
}

function buildChangedNeighborhoods({ previousSnapshot, nextSnapshot, addedEdges, removedEdges }) {
  const previousAdjacency = buildAdjacency(previousSnapshot.edges ?? []);
  const nextAdjacency = buildAdjacency(nextSnapshot.edges ?? []);
  const nodeIds = new Set([
    ...previousAdjacency.keys(),
    ...nextAdjacency.keys(),
  ]);

  const changed = [];
  for (const nodeId of nodeIds) {
    if (!CANONICAL_NODE_TYPES.has(nodeId.split(":")[0])) {
      continue;
    }

    const previousEdgeIds = [...(previousAdjacency.get(nodeId) ?? [])].sort();
    const nextEdgeIds = [...(nextAdjacency.get(nodeId) ?? [])].sort();
    if (JSON.stringify(previousEdgeIds) === JSON.stringify(nextEdgeIds)) {
      continue;
    }

    changed.push({
      node_id: nodeId,
      degree_before: previousEdgeIds.length,
      degree_after: nextEdgeIds.length,
      added_edge_ids: nextEdgeIds.filter((edgeId) => !previousEdgeIds.includes(edgeId)),
      removed_edge_ids: previousEdgeIds.filter((edgeId) => !nextEdgeIds.includes(edgeId)),
    });
  }

  return changed.sort((left, right) => left.node_id.localeCompare(right.node_id));
}

function buildAdjacency(edges) {
  const adjacency = new Map();

  for (const edge of edges) {
    append(adjacency, edge.from, edge.edge_id);
    append(adjacency, edge.to, edge.edge_id);
  }

  return adjacency;
}

function append(map, key, value) {
  if (!map.has(key)) {
    map.set(key, []);
  }
  map.get(key).push(value);
}

function indexBy(entries, key) {
  return new Map((entries ?? []).map((entry) => [entry[key], entry]));
}

function difference(left, right) {
  return [...left.entries()]
    .filter(([key]) => !right.has(key))
    .map(([, value]) => value)
    .sort((a, b) => {
      const leftId = a.node_id ?? a.edge_id;
      const rightId = b.node_id ?? b.edge_id;
      return leftId.localeCompare(rightId);
    });
}

function edgesEquivalent(left, right) {
  return JSON.stringify(projectEdge(left)) === JSON.stringify(projectEdge(right));
}

function projectNode(node) {
  return {
    node_id: node.node_id,
    node_type: node.node_type,
    record_id: node.record_id,
    project_scope: node.project_scope,
    status: node.status,
    review_state: node.review_state ?? null,
  };
}

function projectEdge(edge) {
  return {
    edge_id: edge.edge_id,
    from: edge.from,
    to: edge.to,
    kind: edge.kind,
    confidence_label: edge.confidence_label,
    project_scope: edge.project_scope,
    support_refs: edge.support_refs ?? [],
    source_spans: edge.source_spans ?? [],
    origin_field: edge.origin_field ?? null,
  };
}

module.exports = {
  buildSupportGraphDiff,
};
