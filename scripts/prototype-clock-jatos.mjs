// Source-level compatibility/scheduling experiment, NOT a real JATOS server test.
// node scripts/prototype-clock-jatos.mjs [path-to-jspsych-multiplayer]
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import ts from "typescript";

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sibling = resolve(process.argv[2] ?? resolve(root, "../jspsych-multiplayer"));
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const server = {};
const clients = [];
let conflicts = 0;
let pushes = 0;

function page(id, skew, up, down) {
  const mirror = {};
  let callbacks;
  let online = true;
  let injected = false;
  const jatos = {
    studyResultId: id,
    workerId: id,
    groupResultId: 42,
    groupMembers: ["a", "b"],
    groupChannels: ["a", "b"],
    batchProperties: { maxActiveMembers: 2 },
    joinGroup: (cb) => {
      callbacks = cb;
      return Promise.resolve().then(() => cb.onOpen());
    },
    setGroupFixed: (success) => success(),
    leaveGroup: (success) => {
      online = false;
      success();
    },
    groupSession: {
      getAll: () => mirror,
      set: async (key, value) => {
        pushes++;
        await sleep(up);
        if (id === "b" && value.$clock?.request && !injected) {
          injected = true;
          conflicts++;
          throw new Error("simulated JATOS version conflict");
        }
        server[key] = JSON.parse(JSON.stringify(value));
        const snapshot = JSON.parse(JSON.stringify(server));
        for (const client of clients) client.deliver(snapshot);
        await sleep(down);
      },
    },
  };
  const context = vm.createContext({
    jatos,
    console,
    AbortController,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    window: { setTimeout },
    performance: { now: () => performance.now() + skew },
  });
  const cache = new Map();
  function load(path) {
    if (cache.has(path)) return cache.get(path).exports;
    const module = { exports: {} };
    cache.set(path, module);
    const code = ts.transpileModule(readFileSync(path, "utf8"), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
        esModuleInterop: true,
      },
    }).outputText;
    const localRequire = (name) => {
      if (name === "@jspsych-multiplayer/utils")
        return load(resolve(sibling, "packages/utils/src/index.ts"));
      if (name.startsWith(".")) {
        const target = resolve(dirname(path), name);
        try {
          return load(`${target}.ts`);
        } catch (e) {
          if (e.code !== "ENOENT") throw e;
        }
        return load(resolve(target, "index.ts"));
      }
      return require(name);
    };
    vm.runInContext(`(function(require,module,exports){${code}\n})`, context, { filename: path })(
      localRequire,
      module,
      module.exports
    );
    return module.exports;
  }
  const { MultiplayerAPI } = load(
    resolve(root, "packages/jspsych/src/modules/multiplayer/index.ts")
  );
  const { default: JatosAdapter } = load(
    resolve(sibling, "packages/adapter-multiplayer-jatos/src/index.ts")
  );
  const api = new MultiplayerAPI();
  const client = {
    id,
    api,
    skew,
    deliver: (snapshot) =>
      setTimeout(() => {
        if (!online) return;
        for (const key of Object.keys(mirror)) delete mirror[key];
        Object.assign(mirror, snapshot);
        callbacks?.onGroupSession();
        callbacks?.onGroupSession();
      }, down),
  };
  clients.push(client);
  return { ...client, connect: () => api.connect(new JatosAdapter()) };
}

const a = page("a", 5000, 10, 10);
const b = page("b", -3000, 10, 10);
try {
  await Promise.all([a.connect(), b.connect()]);
  await Promise.all([a.api.waitForGroup({ timeout: 3000 }), b.api.waitForGroup({ timeout: 3000 })]);
  await a.api.clock.ready();
  const calibrating = b.api.clock.ready();
  const studyWrites = Array.from({ length: 12 }, (_, i) => b.api.update({ score: i }));
  await b.api.replace({ score: 12 });
  await Promise.all(studyWrites);
  await calibrating;
  assert.equal(b.api.get("b").score, 12);
  assert.equal(b.api.clock.diagnostics().filter((x) => x.event === "sample").length, 5);
  assert.equal(conflicts, 1);
  assert.ok(b.api.clock.status().uncertainty <= 50);
  const agreement = a.api.now() - b.api.now();
  const bGroundTruthError = b.api.now() - (performance.now() + a.skew);
  assert.ok(Math.abs(bGroundTruthError) <= 50);

  // Immutable schedule, reference validation, acknowledgments, and late entry.
  const reference = a.api.clock.status().reference;
  const schedule = {
    round: "prototype-1",
    reference,
    start: a.api.now() + 2000,
    deadline: a.api.now() + 7000,
  };
  await a.api.update({ schedule });
  const sameTimeCountdownDifference = Math.abs(
    schedule.deadline - a.api.now() - (schedule.deadline - b.api.now())
  );
  await sleep(250); // second client's handlers/entry deliberately later
  const accepted = b.api.get("a").schedule;
  assert.equal(JSON.stringify(accepted.reference), JSON.stringify(b.api.clock.status().reference));
  assert.equal(accepted.round, "prototype-1");
  assert.ok(b.api.now() < accepted.start);
  await b.api.update({ scheduleAck: accepted });
  await a.api.wait((data) => JSON.stringify(data.b?.scheduleAck) === JSON.stringify(schedule), {
    timeout: 1000,
  });
  let inputEnabled = false;
  const observation = async (client) => {
    assert.ok(client.api.now() < schedule.start);
    while (client.api.now() < schedule.start) await sleep(5);
    inputEnabled = true; // instrumented reveal/input enable callback
    const localReveal = performance.now();
    const sharedReveal = client.api.now();
    return {
      id: client.id,
      localReveal,
      sharedReveal,
      remaining: Math.max(0, schedule.deadline - client.api.now()),
    };
  };
  assert.equal(inputEnabled, false);
  const observations = await Promise.all([observation(a), observation(b)]);
  const callbackDifference = Math.abs(observations[0].localReveal - observations[1].localReveal);
  const remainingDifference = Math.abs(observations[0].remaining - observations[1].remaining);
  assert.ok(callbackDifference <= 50);
  assert.ok(remainingDifference <= 50);
  const report = {
    transport: "actual JATOS adapter source / simulated Group Session server",
    skewMs: 8000,
    oneWayMs: 20,
    duplicateNotifications: true,
    conflicts,
    pushes,
    clockAgreementMs: agreement,
    independentSimulatedErrorMs: bGroundTruthError,
    callbackDifferenceMs: callbackDifference,
    countdownAtCommonObservationDifferenceMs: sameTimeCountdownDifference,
    countdownAtEachRevealDifferenceMs: remainingDifference,
    observations,
    clock: b.api.clock.status(),
    diagnostics: b.api.clock.diagnostics(),
    realJatos: "unverified",
    physicalOnset: "not measured",
  };
  const json = JSON.stringify(report, null, 2);
  mkdirSync(resolve(root, "dist"), { recursive: true });
  writeFileSync(resolve(root, "dist/shared-clock-measurements.json"), json, "utf8");
  console.log(json);
} finally {
  await Promise.all(clients.map((client) => client.api.disconnect()));
}
