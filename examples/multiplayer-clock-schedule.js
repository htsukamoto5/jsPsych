// Experiment-level scheduling rules for this disposable demonstration, not a core API.
export function assertClockHorizon(status, horizonMs, maxSampleAge = 30000, maxUncertainty = 50) {
  if (
    status.state !== "ready" ||
    !Number.isFinite(status.sampleAge) ||
    !Number.isFinite(status.uncertainty)
  ) {
    throw new Error("Clock not ready for schedule");
  }
  if (
    ![horizonMs, maxSampleAge, maxUncertainty].every((value) => Number.isFinite(value) && value > 0)
  ) {
    throw new Error("Invalid schedule horizon bounds");
  }
  const projectedAge = status.sampleAge + horizonMs;
  const projectedUncertainty = status.uncertainty + horizonMs * 0.0002;
  if (projectedAge > maxSampleAge || projectedUncertainty > maxUncertainty) {
    throw new Error("Clock quality cannot cover scheduled horizon");
  }
  return Object.freeze({ projectedAge, projectedUncertainty });
}

export function acceptClockSchedule(schedule, reference, round, now) {
  if (
    !schedule ||
    schedule.round !== round ||
    !schedule.reference ||
    ["type", "sessionId", "participantId", "generation"].some(
      (key) => schedule.reference[key] !== reference[key]
    ) ||
    !Number.isFinite(schedule.start) ||
    !Number.isFinite(schedule.deadline) ||
    schedule.deadline <= schedule.start
  ) {
    throw new Error("Round/reference mismatch or invalid schedule");
  }
  if (now >= schedule.start) throw new Error("Late schedule: reveal cancelled");
  return Object.freeze({
    round,
    reference: Object.freeze({ ...reference }),
    start: schedule.start,
    deadline: schedule.deadline,
  });
}

export function clockScheduleFrame(schedule, published, committed, now) {
  if (JSON.stringify(published) !== JSON.stringify(schedule))
    throw new Error("Accepted schedule changed");
  return {
    reveal: committed && now >= schedule.start && now < schedule.deadline,
    remaining: Math.max(0, schedule.deadline - now),
  };
}
