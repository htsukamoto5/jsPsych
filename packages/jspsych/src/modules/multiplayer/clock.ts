import { ConnectionStatus, GroupState, PresenceData } from "./types";

export interface ClockReference {
  type: "participant";
  sessionId: string;
  participantId: string;
  generation: string;
}

export interface ClockStatus {
  state: "unsupported" | "idle" | "waiting_for_group" | "calibrating" | "ready" | "degraded";
  reason: string | null;
  reference: Readonly<ClockReference> | null;
  revision: number;
  /** Shared time minus local performance.now(), in milliseconds. */
  offset: number | null;
  uncertainty: number | null;
  sampleAge: number | null;
}

export interface ClockReadyOptions {
  signal?: AbortSignal;
  timeout?: number;
  maxUncertainty?: number;
  maxSampleAge?: number;
}

export interface ClockDiagnostic {
  local: number;
  event: string;
  rtt?: number;
  offset?: number;
}

export interface ClockAPI {
  ready(options?: ClockReadyOptions): Promise<Readonly<ClockStatus>>;
  status(): Readonly<ClockStatus>;
  diagnostics(): readonly Readonly<ClockDiagnostic>[];
}

interface Request {
  id: string;
  generation: string;
  t1: number;
}
interface Reply extends Request {
  t2: number;
  t3: number;
}
export interface ClockWire {
  request?: Request;
  ack?: string;
  replies?: Record<string, Reply>;
  usable?: boolean;
}

/** Internal boundary: the session owns serialization and keeps this out of study scopes. */
export interface ClockHost {
  participantId: string;
  sessionId: string;
  instance: string;
  /** Page-local session epoch keeps requester IDs unique across explicit reconnects. */
  requestEpoch: number;
  /** This strategy needs an adapter that reports a server-confirmed sealed roster. */
  supportsSealedMembership: boolean;
  status(): ConnectionStatus;
  group(): GroupState;
  presence(): PresenceData;
  peers(): Record<string, { instance: string; clock?: ClockWire }>;
  write(wire: ClockWire): void;
}

interface Sample {
  local: number;
  offset: number;
  rtt: number;
}
const DRIFT = 0.0002;
const MAX_CORRECTION = 50;

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function requestOrder(id: string, instance: string): { epoch: number; sequence: number } | null {
  const prefix = `${instance}:`;
  if (!id.startsWith(prefix)) return null;
  const parts = id.slice(prefix.length).split(":");
  if (parts.length !== 2) return null;
  const [epoch, sequence] = parts.map(Number);
  if (!Number.isSafeInteger(epoch) || epoch < 0 || !Number.isSafeInteger(sequence) || sequence <= 0)
    return null;
  return { epoch, sequence };
}

/** Four application-boundary timestamps; asymmetric transit remains unresolved. */
export function estimateClockSample(t1: number, t2: number, t3: number, t4: number): Sample | null {
  if (![t1, t2, t3, t4].every(finite) || t4 < t1 || t3 < t2) return null;
  const rtt = t4 - t1 - (t3 - t2);
  if (rtt < 0) return null;
  return { local: t4, offset: (t2 - t1 + (t3 - t4)) / 2, rtt };
}

export class MultiplayerClockError extends Error {
  constructor(readonly code: string) {
    super(`Shared clock: ${code}`);
    this.name = "MultiplayerClockError";
  }
}

/** Experimental fixed-reference clock. No background resampling or reference replacement. */
export class MultiplayerClock {
  private state: ClockStatus["state"] = "idle";
  private reason: string | null = null;
  private reference: Readonly<ClockReference> | null = null;
  private revision = 0;
  private anchor: Sample | null = null;
  private lastRead = -Infinity;
  private limit = 50;
  private ageLimit = 30000;
  private sequence = 0;
  private wire: ClockWire = {};
  private log: ClockDiagnostic[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  private lastTick = 0;
  private lastWall = 0;
  private pending: { request: Request; resolve: (sample: Sample | null) => void } | null = null;
  private running: { fail: (reason: string) => void } | null = null;
  private wake: (() => void) | null = null;
  private lost = false;
  /** One tombstone per sealed member prevents recapturing timestamps after reply cleanup. */
  private served = new Map<string, string>();

  constructor(
    private readonly host: ClockHost,
    private readonly local = () => performance.now(),
    private readonly wall = () => Date.now()
  ) {
    if (!host.supportsSealedMembership) {
      this.state = "unsupported";
      this.reason = "sealed_membership_unsupported";
    }
  }

  private record(event: string, sample?: Sample) {
    this.log.push({
      local: this.local(),
      event,
      ...(sample ? { rtt: sample.rtt, offset: sample.offset } : {}),
    });
    if (this.log.length > 32) this.log.shift();
  }

  diagnostics(): readonly Readonly<ClockDiagnostic>[] {
    return Object.freeze(this.log.map((entry) => Object.freeze({ ...entry })));
  }

  status(): Readonly<ClockStatus> {
    this.check();
    const age = this.anchor ? Math.max(0, this.local() - this.anchor.local) : null;
    return Object.freeze({
      state: this.state,
      reason: this.reason,
      reference: this.reference,
      revision: this.revision,
      offset: this.anchor?.offset ?? null,
      uncertainty: this.anchor ? this.anchor.rtt / 2 + age! * DRIFT : null,
      sampleAge: age,
    });
  }

  now(options: { allowDegraded?: boolean } = {}): number {
    const status = this.status();
    if (
      !this.anchor ||
      (status.state !== "ready" && !(options.allowDegraded && status.state === "degraded"))
    ) {
      throw new MultiplayerClockError(status.reason ?? "not_ready");
    }
    this.lastRead = Math.max(this.lastRead, this.local() + this.anchor.offset);
    return this.lastRead;
  }

  private publish() {
    if (this.host.status() !== "closed") this.host.write(this.wire);
  }

  invalidate(reason: string) {
    if (this.state === "degraded" && this.reason === reason) return;
    this.state = "degraded";
    this.reason = reason;
    this.record(reason);
    this.pending?.resolve(null);
    this.running?.fail(reason);
    this.wire = { ...this.wire, usable: false, replies: {}, request: undefined };
    this.publish();
  }

  private check() {
    const now = this.local();
    const wall = this.wall();
    if (
      this.timer &&
      (now - this.lastTick > 2000 || Math.abs(wall - this.lastWall - (now - this.lastTick)) > 2000)
    ) {
      this.lastTick = now;
      this.lastWall = wall;
      this.invalidate("suspended");
    }
    if (
      this.host.status() !== "connected" &&
      (this.state === "ready" || this.state === "calibrating" || this.state === "waiting_for_group")
    ) {
      this.invalidate(this.host.status() === "closed" ? "disconnected" : "reconnecting");
    }
    if (this.reference) {
      const ref = this.reference.participantId;
      const peer = this.host.peers()[ref];
      if (
        this.host.presence()[ref] === "left" ||
        (peer && peer.instance !== this.reference.generation)
      ) {
        this.lost = true;
        this.invalidate("reference_lost");
      } else if (this.host.presence()[ref] !== "connected" && this.state === "ready") {
        this.invalidate("reference_away");
      } else if (
        ref !== this.host.participantId &&
        peer?.clock?.usable === false &&
        this.state === "ready"
      ) {
        this.invalidate("reference_degraded");
      }
    }
    if (this.state === "ready" && this.anchor) {
      const age = now - this.anchor.local;
      if (age > this.ageLimit || this.anchor.rtt / 2 + age * DRIFT > this.limit)
        this.invalidate("quality_expired");
    }
  }

  /** Called on session snapshots, independently of experiment subscriptions. */
  observe() {
    this.check();
    if (!this.reference || this.host.status() !== "connected") return;
    const peers = this.host.peers();
    if (this.reference.participantId === this.host.participantId && this.state === "ready") {
      const replies = { ...this.wire.replies };
      let changed = false;
      for (const id of this.host.group().members) {
        if (id === this.host.participantId) continue;
        const data = peers[id]?.clock;
        const req = data?.request;
        const old = replies[id];
        const instance = peers[id]?.instance;
        const order =
          typeof req?.id === "string" && instance ? requestOrder(req.id, instance) : null;
        const served = this.served.get(id);
        const previous = served && instance ? requestOrder(served, instance) : null;
        if (
          old &&
          (data?.ack === old.id ||
            this.local() - old.t3 > 12000 ||
            this.host.presence()[id] === "left")
        ) {
          delete replies[id];
          changed = true;
        }
        if (
          req &&
          typeof req.id === "string" &&
          req.id.length <= 256 &&
          finite(req.t1) &&
          req.generation === this.reference.generation &&
          this.host.presence()[id] === "connected" &&
          data?.ack !== req.id &&
          order &&
          (!previous ||
            order.epoch > previous.epoch ||
            (order.epoch === previous.epoch && order.sequence > previous.sequence)) &&
          (!old || old.id !== req.id)
        ) {
          const t2 = this.local();
          this.served.set(id, req.id);
          replies[id] = {
            id: req.id,
            generation: req.generation,
            t1: req.t1,
            t2,
            t3: this.local(),
          };
          changed = true;
        }
      }
      if (changed) {
        this.wire = { ...this.wire, replies };
        this.publish();
      }
    }
    const pending = this.pending;
    const reply = peers[this.reference.participantId]?.clock?.replies?.[this.host.participantId];
    if (
      pending &&
      reply &&
      reply.id === pending.request.id &&
      reply.generation === pending.request.generation &&
      reply.t1 === pending.request.t1
    ) {
      const sample = estimateClockSample(reply.t1, reply.t2, reply.t3, this.local());
      if (sample && sample.local - reply.t1 <= 1000) {
        this.pending = null; // A duplicate cannot consume a later outstanding exchange.
        this.wire = { ...this.wire, request: undefined, ack: reply.id };
        this.publish();
        pending.resolve(sample);
      }
    }
  }

  private startWatchdog() {
    if (this.timer) return;
    this.lastTick = this.local();
    this.lastWall = this.wall();
    this.timer = setInterval(() => {
      this.observe();
      this.lastTick = this.local();
      this.lastWall = this.wall();
    }, 250);
    if (typeof document !== "undefined")
      document.addEventListener("visibilitychange", this.visibility);
  }

  private visibility = () => this.invalidate("visibility_changed");

  close() {
    this.invalidate("disconnected");
    clearInterval(this.timer);
    this.timer = undefined;
    if (typeof document !== "undefined")
      document.removeEventListener("visibilitychange", this.visibility);
  }

  async ready(options: ClockReadyOptions = {}): Promise<Readonly<ClockStatus>> {
    const { timeout = 10000, maxUncertainty = 50, maxSampleAge = 30000, signal } = options;
    for (const value of [timeout, maxUncertainty, maxSampleAge]) {
      if (!finite(value) || value <= 0 || value > 2147483647)
        throw new TypeError("Clock bounds must be finite positive milliseconds.");
    }
    if (this.running) throw new MultiplayerClockError("calibration_in_progress");
    if (signal?.aborted) throw new MultiplayerClockError("cancelled");
    this.limit = maxUncertainty;
    this.ageLimit = maxSampleAge;
    if (this.status().state === "ready") return this.status();
    if (this.lost) throw new MultiplayerClockError("reference_lost");
    if (this.host.status() !== "connected") throw new MultiplayerClockError("not_connected");
    if (!this.host.supportsSealedMembership) {
      this.state = "unsupported";
      this.reason = "sealed_membership_unsupported";
      throw new MultiplayerClockError("unsupported");
    }
    this.startWatchdog();
    this.state = "calibrating";
    this.reason = null;
    this.record("calibrating");
    let failure: string | null = null;
    this.running = {
      fail: (reason) => {
        failure = reason;
        this.pending?.resolve(null);
        this.wake?.();
      },
    };
    const fail = (reason: string) => this.running?.fail(reason);
    const abort = () => fail("cancelled");
    signal?.addEventListener("abort", abort, { once: true });
    const deadline = setTimeout(() => fail("timeout"), timeout);
    try {
      // A bounded wait for a sealed roster and the reference's metadata.
      while (!failure && !this.reference) {
        const group = this.host.group();
        if (group.sealed && group.members.length) {
          const id = [...group.members].sort()[0];
          const generation =
            id === this.host.participantId ? this.host.instance : this.host.peers()[id]?.instance;
          if (generation)
            this.reference = Object.freeze({
              type: "participant",
              sessionId: this.host.sessionId,
              participantId: id,
              generation,
            });
        } else {
          this.state = "waiting_for_group";
          this.reason = "sealed_group_required";
        }
        if (!this.reference)
          await new Promise<void>((resolve) => {
            const timer = setTimeout(() => {
              this.wake = null;
              resolve();
            }, 25);
            this.wake = () => {
              clearTimeout(timer);
              this.wake = null;
              resolve();
            };
          });
      }
      if (failure) throw new MultiplayerClockError(failure);
      this.state = "calibrating";
      this.reason = null;
      const samples: Sample[] = [];
      if (this.reference!.participantId === this.host.participantId) {
        samples.push({ local: this.local(), offset: 0, rtt: 0 });
      } else {
        for (let attempt = 0; attempt < 8 && samples.length < 5 && !failure; attempt++) {
          const request: Request = {
            id: `${this.host.instance}:${this.host.requestEpoch}:${++this.sequence}`,
            generation: this.reference!.generation,
            t1: this.local(),
          };
          const sample = await new Promise<Sample | null>((resolve) => {
            const timer = setTimeout(() => {
              this.pending = null;
              resolve(null);
            }, 1000);
            this.pending = {
              request,
              resolve: (sample) => {
                clearTimeout(timer);
                resolve(sample);
              },
            };
            this.wire = { ...this.wire, request };
            this.publish();
            this.observe();
          });
          if (sample) {
            samples.push(sample);
            this.record("sample", sample);
          } else this.record("attempt_expired");
        }
      }
      if (failure) throw new MultiplayerClockError(failure);
      if (samples.length < (this.reference!.participantId === this.host.participantId ? 1 : 5))
        throw new MultiplayerClockError("insufficient_samples");
      const best = samples.reduce((a, b) => (a.rtt <= b.rtt ? a : b));
      const age = this.local() - best.local;
      if (age > maxSampleAge || best.rtt / 2 + age * DRIFT > maxUncertainty)
        throw new MultiplayerClockError("quality_rejected");
      let offset = best.offset;
      if (this.anchor) {
        const correction = offset - this.anchor.offset;
        if (Math.abs(correction) > MAX_CORRECTION)
          throw new MultiplayerClockError("correction_rejected");
        if (correction < 0) offset = this.anchor.offset;
        // Account for retaining the older anchor instead of stalling a countdown.
        best.rtt += Math.abs(offset - best.offset) * 2;
        if (best.rtt / 2 + age * DRIFT > maxUncertainty)
          throw new MultiplayerClockError("quality_rejected");
      }
      this.anchor = { ...best, offset };
      this.revision++;
      this.state = "ready";
      this.reason = null;
      this.wire = { ...this.wire, request: undefined, usable: true };
      this.record("ready");
      this.publish();
      this.observe();
      const status = this.status();
      if (status.state !== "ready") throw new MultiplayerClockError(status.reason ?? "not_ready");
      return status;
    } catch (error) {
      this.state = "degraded";
      this.reason = error instanceof MultiplayerClockError ? error.code : "programming_error";
      this.record(this.reason);
      throw error;
    } finally {
      clearTimeout(deadline);
      signal?.removeEventListener("abort", abort);
      this.pending?.resolve(null);
      this.pending = null;
      this.running = null;
      this.wire = { ...this.wire, request: undefined };
      this.publish();
    }
  }
}
