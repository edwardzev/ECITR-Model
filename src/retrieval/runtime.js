const { buildDefaultLanes } = require("./lanes");
const { RetrievalPlanner } = require("./planner");
const { fuseCandidates } = require("./fusion");

class RetrievalRuntime {
  constructor({ planner = new RetrievalPlanner(), lanesFactory = buildDefaultLanes } = {}) {
    this.planner = planner;
    this.lanesFactory = lanesFactory;
  }

  async execute({ request, catalogs, now = new Date() }) {
    const plan = this.planner.plan(request);
    const lanes = this.lanesFactory({ catalogs, plan });
    const laneCandidates = await Promise.all(
      lanes.map((lane) => lane.execute({ request, plan, now })),
    );

    return {
      plan,
      response: fuseCandidates({ request, plan, laneCandidates, now }),
    };
  }
}

module.exports = {
  RetrievalRuntime,
};
