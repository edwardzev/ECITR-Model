class RetrievalLane {
  constructor({ laneId, supportedLayers }) {
    if (!laneId) {
      throw new Error("RetrievalLane requires a laneId.");
    }

    this.laneId = laneId;
    this.supportedLayers = Object.freeze([...(supportedLayers ?? [])]);
  }

  async execute() {
    throw new Error("execute must be implemented by the retrieval lane.");
  }
}

function assertRetrievalLane(lane) {
  if (!lane || typeof lane.execute !== "function") {
    throw new Error("A valid retrieval lane is required.");
  }

  return lane;
}

module.exports = {
  RetrievalLane,
  assertRetrievalLane,
};
