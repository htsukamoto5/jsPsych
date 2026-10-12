// Real JATOS validation with two isolated Chrome browser contexts. No study asset edits.
// node scripts/prototype-clock-jatos-browser.mjs WORKER_LINK [--full]
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const link = new URL(process.argv[2]);
if (link.protocol !== "https:") throw new Error("Use the supplied HTTPS disposable worker link");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = resolve(root, "dist/jatos-clock", `run-${Date.now()}`);
await mkdir(out, { recursive: true });
const manifest = JSON.parse(
  await readFile(resolve(root, "dist/shared-clock-prototype.manifest.json"), "utf8")
);
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
const debugPort = 9247;
const child = spawn(
  process.env.CLOCK_CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe",
  [
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${resolve(out, "profile")}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
    "about:blank",
  ],
  { stdio: "ignore" }
);
class CDP {
  constructor(url) {
    this.next = 0;
    this.pending = new Map();
    this.events = [];
    this.ws = new WebSocket(url);
    this.open = new Promise((done, fail) => {
      this.ws.onopen = done;
      this.ws.onerror = fail;
    });
    this.ws.onmessage = ({ data }) => {
      const packet = JSON.parse(data);
      if (packet.id) {
        const pending = this.pending.get(packet.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(packet.id);
        packet.error
          ? pending.reject(new Error(JSON.stringify(packet.error)))
          : pending.resolve(packet.result);
      } else {
        const allowed = [
          "Runtime.exceptionThrown",
          "Runtime.consoleAPICalled",
          "Network.responseReceived",
          "Network.loadingFailed",
          "Network.webSocketCreated",
          "Network.webSocketClosed",
          "Network.webSocketFrameError",
        ];
        if (allowed.includes(packet.method)) {
          if (packet.method === "Network.responseReceived") {
            const r = packet.params.response;
            this.events.push({
              method: packet.method,
              url: r.url,
              status: r.status,
              remoteIPAddress: r.remoteIPAddress,
              protocol: r.protocol,
            });
          } else this.events.push(packet);
          if (this.events.length > 128) this.events.shift();
        }
      }
    };
  }
  async call(method, params = {}) {
    await this.open;
    return new Promise((resolve, reject) => {
      const id = ++this.next;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, 20000);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression) {
    const result = await this.call("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }
  close() {
    this.ws.close();
  }
}
const snapshot = `(() => {
  const mp = window.clockPrototypeProbe?.mp;
  let clock, peers, diagnostics;
  try { if(mp?.status) { clock=mp.clock.status(); peers=mp.getAll(); } } catch(error) { clock={error:error.message}; }
  try { diagnostics=JSON.parse(document.querySelector('#diagnostics')?.textContent); } catch {}
  return { url:location.href, title:document.title, message:document.querySelector('#message')?.textContent,
    body:document.body?.innerText.slice(0,4000), hidden:document.querySelector('#stimulus')?.hidden,
    disabled:document.querySelector('#input')?.disabled, visibility:document.visibilityState,
    status:mp?.status, clock, peers, diagnostics, userAgent:navigator.userAgent,
    baseURI:document.baseURI, group:mp?.status?mp.group():null,
    jatos:{version:jatos?.version, workerType:jatos?.workerType, workerId:jatos?.workerId,
      studyResultId:jatos?.studyResultId, groupResultId:jatos?.groupResultId,
      members:jatos?.groupMembers, channels:jatos?.groupChannels, batch:jatos?.batchProperties,
      urlQueryParameters:jatos?.urlQueryParameters},
    screen:{width:screen.width,height:screen.height,dpr:devicePixelRatio} };
})()`;
let browser;
const results = {
  started: new Date().toISOString(),
  sourcePacket: manifest,
  environment: {
    platform: os.platform(),
    release: os.release(),
    cpu: os.cpus()[0]?.model,
    node: process.version,
    host: link.host,
    transport: "real JATOS HTTPS/Group Session WebSocket, no artificial network delay",
    independentWorkers: true,
    independentMachines: false,
    physicalDisplayOnsetMeasured: false,
    browserFlags: "background timer/render/occlusion throttling disabled for controlled baseline",
  },
  scenarios: [],
};
let active = [];
const pages = [];
async function readSnapshot(page) {
  try {
    return await page.eval(snapshot);
  } catch (error) {
    return {
      inspectionError: error.message,
      basic: await page
        .eval("({url:location.href,body:document.body?.innerText.slice(0,3000)})")
        .catch(() => null),
    };
  }
}
async function waitFor(page, predicate, timeout = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const data = await readSnapshot(page);
    if (predicate(data)) return data;
    if (data.message?.startsWith("Stopped:"))
      throw new Error(`Demo stopped: ${JSON.stringify(data)}`);
    await pause(100);
  }
  throw new Error(`Page wait timed out: ${JSON.stringify(await readSnapshot(page))}`);
}
async function newPage(url, left) {
  const { browserContextId } = await browser.call("Target.createBrowserContext", {
    disposeOnDetach: true,
  });
  const { targetId } = await browser.call("Target.createTarget", {
    url: "about:blank",
    browserContextId,
    newWindow: true,
  });
  const win = await browser.call("Browser.getWindowForTarget", { targetId });
  await browser.call("Browser.setWindowBounds", {
    windowId: win.windowId,
    bounds: { left, top: 0, width: 700, height: 800, windowState: "normal" },
  });
  const list = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
  const page = new CDP(list.find((p) => p.id === targetId).webSocketDebuggerUrl);
  Object.assign(page, { targetId, browserContextId });
  pages.push(page);
  active.push(page);
  await page.call("Runtime.enable");
  await page.call("Page.enable");
  await page.call("Network.enable");
  await page.call("Page.navigate", { url });
  return page;
}
async function pair(long = false) {
  const urls = [5000, -3000].map((skew) => {
    const url = new URL(link);
    url.searchParams.set("probe", "1");
    url.searchParams.set("skew", String(skew));
    if (long) {
      url.searchParams.set("duration", "60");
      url.searchParams.set("age", "75000");
    }
    return url.href;
  });
  const a = await newPage(urls[0], 0);
  await pause(250);
  const b = await newPage(urls[1], 705);
  // Inspect stop/failure independently; readiness need not precede the polling callback.
  const ready = await Promise.all(
    [a, b].map((page) => waitFor(page, (d) => d.clock?.state === "ready" && !!d.peers))
  );
  assert.notEqual(String(ready[0].jatos.studyResultId), String(ready[1].jatos.studyResultId));
  assert.notEqual(String(ready[0].jatos.workerId), String(ready[1].jatos.workerId));
  assert.equal(ready[0].clock.reference.sessionId, ready[1].clock.reference.sessionId);
  assert.deepEqual(ready[0].clock.reference, ready[1].clock.reference);
  const reference = ready.findIndex(
    (d) => String(d.jatos.studyResultId) === d.clock.reference.participantId
  );
  return { a, b, ready, reference, ref: [a, b][reference], peer: [a, b][1 - reference] };
}
async function closeActive() {
  for (const page of active) {
    await browser
      .call("Target.disposeBrowserContext", { browserContextId: page.browserContextId })
      .catch(() => {});
    page.close();
  }
  active = [];
}
async function validateAssets(page) {
  const remote = await page.eval(`(async()=>{
    const base = new URL('.',document.baseURI); const manifest = await (await fetch(new URL('build-manifest.json',base))).json();
    const hashes={}; for(const name of Object.keys(manifest.assetSha256)) {
      const bytes=await (await fetch(new URL(name,base))).arrayBuffer();
      hashes[name]=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
    } return {manifest,hashes};
  })()`);
  assert.deepEqual(remote.manifest.sources, manifest.sources);
  assert.deepEqual(remote.hashes, manifest.assetSha256);
  return remote;
}
async function scenario(name, fn) {
  console.log(`JATOS scenario: ${name}`);
  const entry = { name, started: new Date().toISOString() };
  results.scenarios.push(entry);
  try {
    entry.evidence = await fn();
    entry.pass = true;
  } catch (error) {
    entry.pass = false;
    entry.failure = error.message;
    entry.snapshots = await Promise.all(active.map(readSnapshot));
    console.error(
      `${name}: ${entry.snapshots.map((d) => d.message || d.inspectionError).join(" / ")}`
    );
    entry.deployedAssets = await Promise.all(
      active.map((page) => validateAssets(page).catch((e) => ({ error: e.message })))
    );
    const connected = active.find((_, index) => entry.snapshots[index]?.status === "connected");
    if (connected)
      entry.transportDiagnostics = await connected
        .eval(
          `(async()=>{
      const mp=clockPrototypeProbe.mp, now=clockPrototypeProbe.rawNow, pushes=[];
      for(let i=0;i<3;i++){const t=now();try {await mp.update({clockTransportDiagnostic:i});pushes.push({confirmationMs:now()-t});}
        catch(error){pushes.push({error:error.message});break;}}
      return {participantId:mp.participantId,writeConfirmations:pushes,clock:mp.clock.status()};
    })()`
        )
        .catch((e) => ({ error: e.message }));
  } finally {
    entry.events = active.map((page) => ({ targetId: page.targetId, events: page.events }));
    entry.finished = new Date().toISOString();
    for (let i = 0; i < active.length; i++)
      await active[i]
        .call("Page.captureScreenshot", { format: "png" })
        .then((r) =>
          writeFile(
            resolve(out, `${results.scenarios.length}-${i}.png`),
            Buffer.from(r.data, "base64")
          )
        )
        .catch(() => {});
    await writeFile(resolve(out, "results.json"), JSON.stringify(results, null, 2));
    await closeActive();
  }
}
try {
  let version;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      version = await (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json();
      break;
    } catch {
      await pause(100);
    }
  }
  if (!version) throw new Error("Chrome DevTools unavailable");
  results.environment.browser = version.Browser;
  browser = new CDP(version.webSocketDebuggerUrl);
  await scenario(
    "real JATOS import, independent workers, calibration and five-second schedule",
    async () => {
      const p = await pair();
      const assets = await validateAssets(p.a);
      const reveal = await Promise.all(
        [p.a, p.b].map((page) => waitFor(page, (d) => d.message === "Shared countdown running"))
      );
      reveal.forEach((d) => {
        assert.equal(d.hidden, false);
        assert.equal(d.disabled, false);
      });
      assert.deepEqual(reveal[0].diagnostics.schedule, reveal[1].diagnostics.schedule);
      const observations = reveal.map((d) => d.diagnostics.observations[0]);
      const difference = Math.abs(observations[0].shared - observations[1].shared);
      assert.ok(difference <= 50, `Software reveal difference ${difference}ms`);
      const t1 = await p.ref.eval("clockPrototypeProbe.mp.now()");
      const tp = await p.peer.eval("clockPrototypeProbe.mp.now()");
      const t2 = await p.ref.eval("clockPrototypeProbe.mp.now()");
      const finished = await Promise.all(
        [p.a, p.b].map((page) =>
          waitFor(page, (d) => d.message?.startsWith("Countdown finished"), 10000)
        )
      );
      finished.forEach((d) => assert.equal(d.disabled, true));
      return {
        ready: p.ready,
        assets,
        reveal,
        finished,
        sharedRevealDifferenceMs: difference,
        midpointDisagreementMs: tp - (t1 + t2) / 2,
        bracketWidthMs: t2 - t1,
        physicalDisplayOnsetMeasured: false,
      };
    }
  );
  // Feasibility is bounded: stop additional workers if baseline calibration fails.
  if (results.scenarios[0].pass && process.argv.includes("--full")) {
    await scenario("real JATOS60-second explicit75-second age policy", async () => {
      const p = await pair(true);
      const reveal = await Promise.all(
        [p.a, p.b].map((page) => waitFor(page, (d) => d.message === "Shared countdown running"))
      );
      const checkpoints = [];
      for (let i = 0; i < 6; i++) {
        await pause(10000);
        const snapshots = await Promise.all([p.a, p.b].map(readSnapshot));
        snapshots.forEach((d) => {
          assert.equal(d.clock.state, "ready");
          assert.equal(d.clock.revision, 1);
          assert.ok(d.clock.uncertainty <= 50);
        });
        checkpoints.push(snapshots);
        console.log(`Long JATOS round ${i + 1}/6: ready`);
      }
      const finished = await Promise.all(
        [p.a, p.b].map((page) =>
          waitFor(page, (d) => d.message?.startsWith("Countdown finished"), 5000)
        )
      );
      finished.forEach((d) => assert.equal(d.disabled, true));
      return { ready: p.ready, reveal, checkpoints, finished };
    });
    await scenario("real JATOS immutable schedule", async () => {
      const p = await pair();
      await p.ref.eval(
        `(()=>{const mp=clockPrototypeProbe.mp;const id=mp.participantId;return mp.update({schedule:{...mp.get(id).schedule,deadline:mp.get(id).schedule.deadline+1000}});})()`
      );
      const failed = await Promise.all(
        [p.a, p.b].map((page) =>
          waitFor(page, (d) => d.message?.includes("Accepted schedule changed"))
        )
      );
      failed.forEach((d) => assert.equal(d.disabled, true));
      return failed;
    });
    await scenario("real JATOS reference close", async () => {
      const p = await pair();
      await browser.call("Target.closeTarget", { targetId: p.ref.targetId });
      const failed = await waitFor(p.peer, (d) => d.clock?.state === "degraded", 15000);
      assert.equal(failed.disabled, true);
      assert.deepEqual(failed.clock.reference, p.ready[0].clock.reference);
      return failed;
    });
    await scenario("real JATOS background/suspension after reveal", async () => {
      const p = await pair();
      const revealed = await waitFor(p.peer, (d) => d.message === "Shared countdown running");
      await p.peer.call("Page.setWebLifecycleState", { state: "frozen" });
      await pause(2500);
      await p.peer.call("Page.setWebLifecycleState", { state: "active" });
      const failed = await waitFor(p.peer, (d) => d.clock?.state === "degraded");
      assert.equal(failed.disabled, true);
      return { revealed, failed };
    });
  }
} catch (error) {
  results.fatal = error.message;
  console.error(error.message);
} finally {
  results.finished = new Date().toISOString();
  await writeFile(resolve(out, "results.json"), JSON.stringify(results, null, 2));
  await closeActive();
  for (const page of pages) page.close();
  if (browser) {
    await browser.call("Browser.close").catch(() => {});
    browser.close();
  }
  child.kill();
}
console.log(`JATOS diagnostics: ${resolve(out, "results.json")}`);
console.log(
  JSON.stringify(
    results.scenarios.map(({ name, pass, failure }) => ({
      name,
      pass,
      failure: failure?.includes("quality_rejected") ? "quality_rejected" : failure?.slice(0, 200),
    })),
    null,
    2
  )
);
if (results.fatal || results.scenarios.some((s) => !s.pass)) process.exitCode = 1;
