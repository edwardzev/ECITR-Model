const DEFAULT_ROLE_REGISTRY = Object.freeze({
  "Evidence Steward": {
    owns: ["evidence"],
  },
  "Case Steward": {
    owns: ["cases"],
  },
  "Invariant Steward": {
    owns: ["invariants"],
  },
  "Tactic Steward": {
    owns: ["tactics"],
  },
  "Retrieval Architect": {
    owns: ["retrieval"],
  },
  "Docs Atlas Steward": {
    owns: ["docs"],
  },
  "Governance and QA Steward": {
    owns: ["governance"],
  },
  Researcher: {
    owns: [],
  },
  Orchestrator: {
    owns: [],
  },
});

function getPrimaryRoleForLayer(layer) {
  for (const [roleName, roleDef] of Object.entries(DEFAULT_ROLE_REGISTRY)) {
    if (roleDef.owns.includes(layer)) {
      return roleName;
    }
  }

  return "Orchestrator";
}

module.exports = {
  DEFAULT_ROLE_REGISTRY,
  getPrimaryRoleForLayer,
};
