/* Standalone prototype; never loaded by a paid study. JATOS assets are prepared separately. */
import { acceptClockSchedule, assertClockHorizon, clockScheduleFrame } from "./multiplayer-clock-schedule.js";
(async () => {
  const params = new URLSearchParams(location.search);
  const isJatos = params.get("backend") === "jatos";
  if (isJatos) {
    if (!window.jatos) await script("jatos.js");
    await new Promise((resolve) => jatos.onLoad(resolve));
    // JATOS preserves worker-link parameters here, not necessarily in the component URL.
    for (const [key, value] of Object.entries(jatos.urlQueryParameters || {}))
      if (!params.has(key)) params.set(key, String(value));
  }
  const message = document.getElementById("message");
  const countdown = document.getElementById("countdown");
  const stimulus = document.getElementById("stimulus");
  const input = document.getElementById("input");
  const diagnostics = document.getElementById("diagnostics");
  const rawNow = performance.now.bind(performance);
  const skew = Number(params.get("skew") || 0);
  if (!Number.isFinite(skew)) throw new Error("Invalid skew");
  const duration = Number(params.get("duration") || 5) * 1000;
  const maxSampleAge = Number(params.get("age") || 30000);
  if (![5000, 60000].includes(duration) || ![30000, 75000].includes(maxSampleAge))
    throw new Error("Demo duration must be 5 or 60 seconds; age must be 30000 or 75000 ms");
  if (duration === 60000 && params.get("age") !== "75000")
    throw new Error("60-second prototype requires explicit age=75000 policy");
  // Intentionally skew only this disposable demo page's monotonic axis.
  Object.defineProperty(performance, "now", { value: () => rawNow() + skew });
  const jsPsych = initJsPsych();
  const mp = jsPsych.multiplayer;
  const observations = [];
  let stopped = false;
  let accepted;
  let transportControls;
  let qualityMonitor;

  function checkQuality() {
    const status = mp.clock.status();
    if (status.state === "degraded") fail(new Error(`Shared clock: ${status.reason}`));
  }

  function stopQualityMonitor() {
    clearInterval(qualityMonitor);
    document.removeEventListener("visibilitychange", checkQuality);
  }

  // Opt-in inspection hook for the disposable browser validation harness only.
  if (params.get("probe") === "1")
    Object.defineProperty(window, "clockPrototypeProbe", {
      value: Object.freeze({ mp, rawNow, get transport() { return transportControls; } }),
    });

  function fail(error) {
    stopped = true;
    stopQualityMonitor();
    stimulus.hidden = true;
    input.disabled = true;
    message.textContent = `Stopped: ${error.message || error}`;
    diagnostics.textContent = JSON.stringify(
      {
        participantId: mp.participantId,
        accepted,
        observations,
        policy: { duration, maxSampleAge, maxUncertainty: 50, driftPpm: 200 },
        clock: mp.clock.status(),
        calibration: mp.clock.diagnostics(),
        peerObservations: mp.getAll(),
      },
      null,
      2
    );
  }

  async function script(src) {
    await new Promise((resolve, reject) => {
      const element = document.createElement("script");
      element.src = src;
      element.onload = resolve;
      element.onerror = () => reject(new Error(`Cannot load ${src}`));
      document.head.appendChild(element);
    });
  }

  // Development transport: latest participant slots, mirrored with snapshots on join.
  // Deployment uses the unchanged sibling JATOS adapter instead of this class.
  class DemoAdapter {
    async connect(options) {
      const id = params.get("id");
      if (!["a", "b"].includes(id)) throw new Error("Local demo requires id=a or id=b");
      const sessionId = params.get("session") || "clock-prototype";
      const delay = Number(params.get("delay") || 0);
      if (!Number.isFinite(delay) || delay < 0 || delay > 500)
        throw new Error("Delay must be 0–500 ms");
      const channel = new BroadcastChannel(`jspsych-clock:${sessionId}`);
      const data = {};
      const seen = { [id]: Date.now() };
      let closed = false;
      let interrupted = false;
      channel.onmessage = ({ data: packet }) => {
        if (interrupted) return;
        if (!["a", "b"].includes(packet.id)) return;
        seen[packet.id] = Date.now();
        if (packet.hello && data[id]) channel.postMessage({ id, slot: data[id] });
        if (packet.slot) data[packet.id] = packet.slot;
        options.onChange();
      };
      const timer = setInterval(() => {
        if (interrupted) return;
        channel.postMessage({ id, hello: true });
        options.onChange();
      }, 500);
      channel.postMessage({ id, hello: true });
      transportControls = Object.freeze({
        interrupt() { interrupted = true; options.onStatus("reconnecting"); },
        resume() {
          interrupted = false;
          options.onStatus("connected");
          channel.postMessage({ id, hello: true });
        },
        slot() { return structuredClone(data[id]); },
      });
      return {
        participantId: id,
        sessionId,
        getAll: () => data,
        connectedParticipants: () =>
          Object.keys(seen).filter((peer) => Date.now() - seen[peer] < 2000),
        group: () => ({ size: 2, members: ["a", "b"], sealed: true }),
        push: async (slot) => {
          await new Promise((resolve) => setTimeout(resolve, delay));
          if (closed) throw new Error("Closed");
          if (interrupted) throw new Error("Development transport interrupted");
          data[id] = slot;
          channel.postMessage({ id, slot });
          options.onChange();
        },
        disconnect: async () => {
          closed = true;
          clearInterval(timer);
          channel.close();
        },
      };
    }
  }

  try {
    let adapter;
    if (isJatos) {
      await script("adapter-multiplayer-jatos.js");
      adapter = new jsPsychAdapterMultiplayerJatos();
    } else adapter = new DemoAdapter();
    await mp.connect(adapter);
    await mp.waitForGroup({ timeout: 10000 });
    await mp.clock.ready({ maxSampleAge });
    // Background pages can stop RAF while timers/lifecycle events still detect degradation.
    document.addEventListener("visibilitychange", checkQuality);
    qualityMonitor = setInterval(checkQuality, 250);
    const reference = mp.clock.status().reference;
    const referenceKey = JSON.stringify(reference);
    const ref = reference.participantId;
    const members = mp.group().members;
    if (members.length !== 2) throw new Error("Demo requires exactly two sealed members");
    await mp.update({ clockPrepared: referenceKey });
    await mp.wait((data) => members.every((id) => data[id]?.clockPrepared === referenceKey), {
      timeout: 10000,
    });
    assertClockHorizon(mp.clock.status(), duration + 2000, maxSampleAge);
    if (mp.participantId === ref) {
      const start = mp.now() + 2000;
      await mp.update({
        schedule: { round: "prototype-1", reference, start, deadline: start + duration },
      });
    }
    await mp.wait((data) => !!data[ref]?.schedule, { timeout: 5000 });
    const schedule = acceptClockSchedule(mp.get(ref).schedule, reference, "prototype-1", mp.now());
    assertClockHorizon(mp.clock.status(), schedule.deadline - mp.now(), maxSampleAge);
    accepted = JSON.stringify(schedule); // immutable round acceptance
    await mp.update({ scheduleAck: accepted });
    if (mp.participantId === ref) {
      await mp.wait((data) => members.every((id) => data[id]?.scheduleAck === accepted), {
        timeout: 1500,
      });
      await mp.update({ scheduleCommit: accepted });
    }
    await mp.wait((data) => data[ref]?.scheduleCommit === accepted, { timeout: 1500 });
    if (mp.now() >= schedule.start) throw new Error("Late commit: reveal cancelled");
    message.textContent = "Prepared. Waiting for shared start…";
    let revealed = false;
    const tick = () => {
      if (stopped) return;
      try {
        const now = mp.now();
        const frame = clockScheduleFrame(schedule, mp.get(ref).schedule, true, now);
        countdown.textContent = `${(frame.remaining / 1000).toFixed(2)} seconds`;
        if (!revealed && frame.reveal) {
          revealed = true;
          stimulus.hidden = false;
          input.disabled = false;
          // Callback reads bracket the software DOM operation, not physical display onset.
          observations.push({
            operation: "reveal_and_enable_input",
            rawLocal: rawNow(),
            local: performance.now(),
            shared: mp.now(),
            revision: mp.clock.status().revision,
          });
          void mp.update({ revealObservation: observations[0] }).catch(fail);
          message.textContent = "Shared countdown running";
        }
        diagnostics.textContent = JSON.stringify(
          {
            participantId: mp.participantId,
            policy: { duration, maxSampleAge, maxUncertainty: 50, driftPpm: 200 },
            schedule,
            clock: mp.clock.status(),
            observations,
            peerObservations: mp.getAll(),
            calibration: mp.clock.diagnostics(),
          },
          null,
          2
        );
        if (now < schedule.deadline) requestAnimationFrame(tick);
        else {
          input.disabled = true;
          stopQualityMonitor();
          message.textContent = "Countdown finished (prototype)";
        }
      } catch (error) {
        fail(error);
      }
    };
    requestAnimationFrame(tick);
    window.addEventListener(
      "pagehide",
      () => {
        stopQualityMonitor();
        void mp.disconnect();
      },
      { once: true }
    );
  } catch (error) {
    fail(error);
    await mp.disconnect();
  }
})();
