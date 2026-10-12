import {
  ClockHost,
  ClockWire,
  MultiplayerClock,
  estimateClockSample,
} from "../../src/modules/multiplayer/clock";
import { ConnectionStatus, PresenceData } from "../../src/modules/multiplayer/types";

async function flush() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

/** Persistent per-participant state with controllable delivery, duplicates and skew. */
class Network {
  time = 0;
  wall = 0;
  delay = { a: 20, b: 20 };
  offset = { a: 5000, b: -3000 };
  rate = { a: 1, b: 1 };
  statuses: Record<string, ConnectionStatus> = { a: "connected", b: "connected" };
  presence: PresenceData = { a: "connected", b: "connected" };
  instances = { a: "page-a", b: "page-b" };
  mirrors: Record<string, Record<string, ClockWire>> = { a: {}, b: {} };
  clocks: Record<string, MultiplayerClock> = {};
  wires: Record<string, ClockWire> = {};
  drop = false;
  sealed = true;
  throwRequestOnce = false;
  requestError = new Error("request programming error");
  constructor() {
    for (const id of ["a", "b"] as const) {
      const host: ClockHost = {
        participantId: id,
        sessionId: "group",
        instance: this.instances[id],
        requestEpoch: 1,
        supportsSealedMembership: true,
        status: () => this.statuses[id],
        group: () => ({ members: ["b", "a"], size: 2, sealed: this.sealed }),
        presence: () => this.presence,
        peers: () =>
          Object.fromEntries(
            ["a", "b"]
              .filter((p) => p !== id)
              .map((p) => [p, { instance: this.instances[p], clock: this.mirrors[id][p] }])
          ),
        write: (wire) => {
          if (wire.request && this.throwRequestOnce) {
            this.throwRequestOnce = false;
            throw this.requestError;
          }
          const copy = JSON.parse(JSON.stringify(wire));
          this.wires[id] = copy;
          if (this.drop) return;
          const other = id === "a" ? "b" : "a";
          setTimeout(() => {
            this.mirrors[other][id] = copy;
            this.clocks[other].observe();
          }, this.delay[id]);
        },
      };
      this.clocks[id] = new MultiplayerClock(
        host,
        () => this.time * this.rate[id] + this.offset[id],
        () => this.wall
      );
    }
  }
  async advance(ms: number) {
    for (let elapsed = 0; elapsed < ms; elapsed += 10) {
      this.time += 10;
      this.wall += 10;
      jest.advanceTimersByTime(10);
      await flush();
    }
  }
  async ready() {
    await this.clocks.a.ready();
    const ready = this.clocks.b.ready();
    await this.advance(700);
    await ready;
  }
  close() {
    Object.values(this.clocks).forEach((clock) => clock.close());
  }
}

let net: Network;
beforeEach(() => {
  jest.useFakeTimers();
  net = new Network();
});
afterEach(() => {
  net.close();
  jest.useRealTimers();
});

test("four timestamps remove known skew and reference processing delay", () => {
  expect(estimateClockSample(100, 520, 530, 150)).toEqual({ local: 150, offset: 400, rtt: 40 });
  expect(estimateClockSample(100, 200, 210, 105)).toBeNull();
  expect(estimateClockSample(100, NaN, 200, 300)).toBeNull();
});

test("bounded calibration agrees under 8-second skew, with diagnostics and reference identity", async () => {
  expect(() => net.clocks.b.now()).toThrow("not_ready");
  await net.ready();
  expect(net.clocks.b.status()).toMatchObject({
    state: "ready",
    revision: 1,
    offset: 8000,
    reference: { participantId: "a", generation: "page-a" },
  });
  expect(net.clocks.a.now() - net.clocks.b.now()).toBe(0);
  expect(net.clocks.b.diagnostics().filter((x) => x.event === "sample")).toHaveLength(5);
  await net.advance(100);
  expect(net.wires.a.replies).toEqual({});
});

test("asymmetry biases offset within provisional RTT uncertainty; excessive delay fails", async () => {
  net.delay = { a: 70, b: 10 };
  await net.ready();
  expect(net.clocks.a.now() - net.clocks.b.now()).toBe(30);
  expect(net.clocks.b.status().uncertainty).toBeGreaterThanOrEqual(40);
  net.clocks.b.invalidate("revalidate");
  net.delay = { a: 100, b: 100 };
  const ready = net.clocks.b.ready().catch((e) => e.code);
  await net.advance(1200);
  expect(await ready).toBe("quality_rejected");
});

test("duplicates and stale replies leave the current request intact and count only once", async () => {
  await net.clocks.a.ready();
  const ready = net.clocks.b.ready();
  await net.advance(50);
  const stale = JSON.parse(JSON.stringify(net.mirrors.b.a));
  const pending = net.wires.b.request?.id;
  net.mirrors.b.a = stale;
  for (let i = 0; i < 10; i++) net.clocks.b.observe();
  expect(net.wires.b.request?.id).toBe(pending);
  await net.advance(250);
  await ready;
  expect(net.clocks.b.diagnostics().filter((x) => x.event === "sample")).toHaveLength(5);
});

test("attempt limits, overall timeout, and abort do not leave live requests", async () => {
  await net.clocks.a.ready();
  net.drop = true;
  const limited = net.clocks.b.ready().catch((e) => e.code);
  await net.advance(8100);
  expect(await limited).toBe("insufficient_samples");
  expect(net.clocks.b.diagnostics().filter((x) => x.event === "attempt_expired")).toHaveLength(8);
  expect(net.wires.b.request).toBeUndefined();
  const timed = net.clocks.b.ready({ timeout: 400 }).catch((e) => e.code);
  await net.advance(410);
  expect(await timed).toBe("timeout");
  const controller = new AbortController();
  const aborted = net.clocks.b.ready({ signal: controller.signal }).catch((e) => e.code);
  controller.abort();
  await flush();
  expect(await aborted).toBe("cancelled");
  expect(net.wires.b.request).toBeUndefined();
});

test("drift increases uncertainty and age expiry requires explicit revalidation", async () => {
  await net.ready();
  net.rate.b = 1.0002;
  const initial = net.clocks.b.status().uncertainty!;
  await net.advance(29000);
  expect(net.clocks.b.status().uncertainty).toBeGreaterThan(initial + 5);
  expect(Math.abs(net.clocks.a.now() - net.clocks.b.now())).toBeLessThan(7);
  await net.advance(1500);
  expect(net.clocks.b.status()).toMatchObject({ state: "degraded", reason: "quality_expired" });
  expect(() => net.clocks.b.now()).toThrow("quality_expired");
  expect(Number.isFinite(net.clocks.b.now({ allowDegraded: true }))).toBe(true);
});

test("wall jumps, stalls, visibility and paused monotonic sleep degrade without changing the reference", async () => {
  await net.ready();
  const identity = net.clocks.b.status().reference;
  net.wall += 5000;
  expect(net.clocks.b.status().reason).toBe("suspended");
  expect(net.clocks.b.status().reference).toEqual(identity);
  await net.clocks.a.ready();
  const ready = net.clocks.b.ready();
  await net.advance(300);
  await ready;
  net.time += 3000;
  net.wall += 3000;
  expect(net.clocks.b.status().reason).toBe("suspended");
  document.dispatchEvent(new Event("visibilitychange"));
  expect(net.clocks.b.status().reason).toBe("visibility_changed");
});

test("small backwards correction keeps countdown rate; large corrections are rejected", async () => {
  await net.ready();
  const before = net.clocks.b.now();
  net.offset.b += 10;
  net.clocks.b.invalidate("revalidate");
  const ready = net.clocks.b.ready();
  await net.advance(300);
  await ready;
  expect(net.clocks.b.status().revision).toBe(2);
  const after = net.clocks.b.now();
  expect(after).toBeGreaterThanOrEqual(before);
  await net.advance(100);
  expect(net.clocks.b.now() - after).toBe(100);
  net.offset.b -= 200;
  net.clocks.b.invalidate("revalidate");
  const bad = net.clocks.b.ready().catch((e) => e.code);
  await net.advance(300);
  expect(await bad).toBe("correction_rejected");
  expect(net.clocks.b.status().revision).toBe(2);
});

test("disconnect cancels; reconnect needs calibration; reference loss never elects a successor", async () => {
  await net.ready();
  net.statuses.b = "reconnecting";
  net.clocks.b.observe();
  expect(net.clocks.b.status().reason).toBe("reconnecting");
  net.statuses.b = "connected";
  expect(net.clocks.b.status().state).toBe("degraded");
  const ready = net.clocks.b.ready();
  await net.advance(300);
  await ready;
  net.presence.a = "away";
  net.clocks.b.observe();
  expect(net.clocks.b.status().reason).toBe("reference_away");
  net.presence.a = "left";
  net.clocks.b.observe();
  await expect(net.clocks.b.ready()).rejects.toMatchObject({ code: "reference_lost" });
  expect(net.clocks.b.status().reference?.participantId).toBe("a");
});

test("reference reload is a generation loss, not a local revision", async () => {
  await net.ready();
  net.instances.a = "new-page";
  net.clocks.b.observe();
  expect(net.clocks.b.status()).toMatchObject({
    state: "degraded",
    reason: "reference_lost",
    revision: 1,
  });
  await expect(net.clocks.b.ready()).rejects.toMatchObject({ code: "reference_lost" });
});

test("waiting for sealed grouping and disconnected pending calibration are bounded", async () => {
  net.sealed = false;
  const wait = net.clocks.b.ready({ timeout: 100 }).catch((e) => e.code);
  expect(net.clocks.b.status().state).toBe("waiting_for_group");
  await net.advance(110);
  expect(await wait).toBe("timeout");
  net.sealed = true;
  net.drop = true;
  const pending = net.clocks.b.ready().catch((e) => e.code);
  net.statuses.b = "closed";
  net.clocks.b.close();
  expect(await pending).toBe("disconnected");
});

test("a supported group can seal during the pending wait without a second calibration call", async () => {
  net.sealed = false;
  const a = net.clocks.a.ready();
  const b = net.clocks.b.ready();
  expect(net.clocks.a.status().state).toBe("waiting_for_group");
  await net.advance(50);
  net.sealed = true;
  await net.advance(700);
  await Promise.all([a, b]);
  expect(net.clocks.b.status().state).toBe("ready");
});

test("diagnostics stay bounded across repeated failed calibrations", async () => {
  net.drop = true;
  for (let i = 0; i < 5; i++) {
    const wait = net.clocks.b.ready().catch(() => {});
    await net.advance(8100);
    await wait;
  }
  expect(net.clocks.b.diagnostics().length).toBeLessThanOrEqual(32);
});

test("minimum RTT rejects an outlier and expired replies cannot become fresh samples", async () => {
  await net.clocks.a.ready();
  net.delay = { a: 400, b: 400 };
  const ready = net.clocks.b.ready();
  await net.advance(810);
  net.delay = { a: 20, b: 20 };
  await net.advance(2000);
  await ready;
  const samples = net.clocks.b.diagnostics().filter((entry) => entry.event === "sample");
  expect(samples[0].rtt).toBe(800);
  expect(net.clocks.b.status().uncertainty).toBeLessThan(25);
  net.clocks.b.invalidate("revalidate");
  net.delay = { a: 1100, b: 20 };
  const second = net.clocks.b.ready();
  await net.advance(1030);
  net.delay = { a: 20, b: 20 };
  await net.advance(2200);
  await second;
  expect(net.clocks.b.status().revision).toBe(2);
  expect(net.clocks.b.diagnostics().filter((entry) => entry.event === "sample")).toHaveLength(10);
});

test("sample age bound is applied at calibration completion, not renewed by retries", async () => {
  await net.clocks.a.ready();
  const result = net.clocks.b.ready({ maxSampleAge: 100 }).catch((e) => e.code);
  await net.advance(50);
  net.delay = { a: 100, b: 100 };
  await net.advance(1100);
  expect(await result).toBe("quality_rejected");
});

test("disconnect during calibration clears the watchdog and rejects without a timeout label", async () => {
  net.drop = true;
  const result = net.clocks.b.ready().catch((e) => e.code);
  net.statuses.b = "closed";
  net.clocks.b.close();
  expect(await result).toBe("disconnected");
  expect(jest.getTimerCount()).toBe(0);
});

test("programming errors clear attempt timers and are never relabeled as timeouts", async () => {
  await net.clocks.a.ready();
  net.throwRequestOnce = true;
  await expect(net.clocks.b.ready()).rejects.toBe(net.requestError);
  expect(net.clocks.b.status().reason).toBe("programming_error");
  await net.advance(100);
  expect(jest.getTimerCount()).toBe(2); // watchdogs only, no orphaned attempt timer
  const ready = net.clocks.b.ready();
  await net.advance(700);
  await ready;
  expect(net.clocks.b.status().state).toBe("ready");
});

test("a cleaned-up request ID never receives recaptured reference timestamps", async () => {
  await net.clocks.a.ready();
  const request = { id: "page-b:1:99", generation: "page-a", t1: -3000 };
  net.mirrors.a.b = { request };
  net.clocks.a.observe();
  const reply = JSON.parse(JSON.stringify(net.wires.a.replies!.b));
  net.clocks.a.observe();
  expect(net.wires.a.replies!.b).toEqual(reply);
  await net.advance(12500);
  expect(net.wires.a.replies!.b).toBeUndefined();
  net.clocks.a.observe();
  expect(net.wires.a.replies!.b).toBeUndefined();
  net.mirrors.a.b = { request: { ...request, id: "page-b:1:100", t1: net.time - 3000 } };
  net.clocks.a.observe();
  expect(net.wires.a.replies!.b.id).toBe("page-b:1:100");
  net.mirrors.a.b = { request };
  net.clocks.a.observe();
  expect(net.wires.a.replies!.b.id).toBe("page-b:1:100"); // stale request cannot recapture t2
});

test("default age fails a 60-second round; explicit75s policy covers known200ppm drift", async () => {
  await net.ready();
  net.rate.b = 1.0002;
  const reference = net.clocks.b.status().reference;
  for (const clock of Object.values(net.clocks)) await clock.ready({ maxSampleAge: 75000 });
  const start = net.clocks.a.now() + 2000;
  const deadline = start + 60000;
  let previous = net.clocks.b.now();
  let maxDisagreement = 0;
  for (let second = 0; second < 62; second++) {
    await net.advance(1000);
    const current = net.clocks.b.now();
    expect(current).toBeGreaterThan(previous);
    expect(net.clocks.b.status().state).toBe("ready");
    expect(net.clocks.b.status().uncertainty).toBeLessThan(50);
    maxDisagreement = Math.max(maxDisagreement, Math.abs(net.clocks.a.now() - current));
    previous = current;
  }
  expect(maxDisagreement).toBeLessThan(13);
  expect(net.clocks.b.status().sampleAge).toBeLessThan(75000);
  expect(net.clocks.b.status().reference).toEqual(reference);
  expect(net.clocks.b.status().revision).toBe(1); // no mid-round correction
  expect(Math.max(0, deadline - net.clocks.b.now())).toBe(0);
  net.presence.a = "left";
  expect(() => net.clocks.b.now()).toThrow("reference_lost");
});
