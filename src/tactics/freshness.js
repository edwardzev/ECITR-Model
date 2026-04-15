function evaluateTacticFreshness(
  tactic,
  { now = new Date(), environmentTags = [], strictEnvironment = false } = {},
) {
  const reasons = [];

  if (Array.isArray(tactic.invalidated_by) && tactic.invalidated_by.length > 0) {
    reasons.push("tactic has explicit invalidation markers");
    return { status: "invalidated", usable: false, reasons };
  }

  if (tactic.expiry_at && now > new Date(tactic.expiry_at)) {
    reasons.push("tactic expiry_at is in the past");
    return { status: "expired", usable: false, reasons };
  }

  if (tactic.revalidate_at && now > new Date(tactic.revalidate_at)) {
    reasons.push("tactic revalidate_at is in the past");
    return { status: "revalidation_due", usable: false, reasons };
  }

  if (strictEnvironment && Array.isArray(tactic.environment_bounds) && tactic.environment_bounds.length) {
    const missing = tactic.environment_bounds.filter((bound) => !environmentTags.includes(bound));
    if (missing.length > 0) {
      reasons.push(`environment mismatch: missing ${missing.join(", ")}`);
      return { status: "environment_mismatch", usable: false, reasons };
    }
  }

  return { status: "fresh", usable: true, reasons };
}

module.exports = {
  evaluateTacticFreshness,
};
