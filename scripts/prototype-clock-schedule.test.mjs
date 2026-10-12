import assert from "node:assert/strict";

import test from "node:test";

import {
  acceptClockSchedule,
  assertClockHorizon,
  clockScheduleFrame,
} from "../examples/multiplayer-clock-schedule.js";

const reference = {
  type: "participant",
  sessionId: "group",
  participantId: "a",
  generation: "page-a",
};
const schedule = { round: "round-1", reference, start: 2000, deadline: 7000 };

test("60-second horizon needs explicit age policy and preserves uncertainty headroom", () => {
  const status = { state: "ready", sampleAge: 400, uncertainty: 20.08 };
  assert.throws(() => assertClockHorizon(status, 62000), /cannot cover/);
  assert.deepEqual(assertClockHorizon(status, 62000, 75000), {
    projectedAge: 62400,
    projectedUncertainty: 32.48,
  });
  assert.throws(
    () => assertClockHorizon({ ...status, uncertainty: 40 }, 62000, 75000),
    /cannot cover/
  );
  assert.throws(
    () => assertClockHorizon({ ...status, sampleAge: 15000 }, 62000, 75000),
    /cannot cover/
  );
  assert.throws(
    () => assertClockHorizon({ ...status, state: "degraded" }, 62000, 75000),
    /not ready/
  );
});

test("late entry retains one deadline; reveal/input stay gated until committed start", () => {
  const early = acceptClockSchedule(schedule, reference, "round-1", 0);
  const later = acceptClockSchedule(schedule, reference, "round-1", 750);
  assert.deepEqual(early, later);
  assert.equal(clockScheduleFrame(later, schedule, true, 1900).reveal, false);
  assert.equal(clockScheduleFrame(later, schedule, false, 2100).reveal, false);
  assert.equal(clockScheduleFrame(later, schedule, true, 2100).reveal, true);
  assert.equal(clockScheduleFrame(later, schedule, true, 2100).remaining, 4900);
  assert.equal(clockScheduleFrame(later, schedule, true, 7100).remaining, 0);
});

test("mismatched reference generation/session and stale round are rejected", () => {
  for (const key of ["sessionId", "generation", "participantId", "type"]) {
    assert.throws(() =>
      acceptClockSchedule(schedule, { ...reference, [key]: "other" }, "round-1", 0)
    );
  }
  assert.throws(() => acceptClockSchedule(schedule, reference, "round-2", 0));
});

test("late delivery fails without exposing the stimulus", () => {
  assert.throws(() => acceptClockSchedule(schedule, reference, "round-1", 2000), /Late schedule/);
  assert.throws(() => acceptClockSchedule(schedule, reference, "round-1", 2100), /Late schedule/);
});

test("an accepted schedule is frozen and cannot silently change", () => {
  const accepted = acceptClockSchedule(schedule, reference, "round-1", 0);
  assert.throws(() => {
    accepted.start = 3000;
  }, TypeError);
  assert.throws(() => {
    accepted.reference.generation = "replacement";
  }, TypeError);
  assert.throws(
    () => clockScheduleFrame(accepted, { ...schedule, deadline: 9000 }, true, 2100),
    /changed/
  );
});
