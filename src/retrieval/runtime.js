const { buildDefaultLanes } = require("./lanes");
const { RetrievalPlanner } = require("./planner");
const { fuseCandidates } = require("./fusion");
const { enrichResponseWithSupportGraph } = require("./support-graph-enricher");
const { DEFAULT_GRAPH_ROOT } = require("../support-graph/refresh");

class RetrievalRuntime {
  constructor({
    planner = new RetrievalPlanner(),
    lanesFactory = buildDefaultLanes,
    responseEnricher = enrichResponseWithSupportGraph,
    graphRoot = DEFAULT_GRAPH_ROOT,
  } = {}) {
    this.planner = planner;
    this.lanesFactory = lanesFactory;
    this.responseEnricher = responseEnricher;
    this.graphRoot = graphRoot;
  }

  async execute({ request, catalogs, now = new Date() }) {
    const plan = this.planner.plan(request);
    const lanes = this.lanesFactory({ catalogs, plan });
    const laneCandidates = await Promise.all(
      lanes.map((lane) => lane.execute({ request, plan, now })),
    );
    const fusedResponse = fuseCandidates({ request, plan, laneCandidates, now });
    const response = this.responseEnricher
      ? this.responseEnricher({
        response: fusedResponse,
        request,
        plan,
        catalogs,
        now,
        graphRoot: this.graphRoot,
      })
      : fusedResponse;

    return {
      plan,
      response,
    };
  }
}

module.exports = {
  RetrievalRuntime,
};
