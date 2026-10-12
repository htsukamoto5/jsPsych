// Real Chrome, isolated disposable profile, two visible windows. No external dependencies.
// Run after npm run build --workspace jspsych. Outputs ignored diagnostic artifacts.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import os from "node:os";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = resolve(root, "dist/browser-clock", `run-${Date.now()}`);
await mkdir(out, { recursive: true });
const port = 8776;
const debugPort = 9237;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = process.env.CLOCK_CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
const server = createServer(async (req, res) => {
  try {
    const file = resolve(root, `.${decodeURIComponent(new URL(req.url, "http://localhost").pathname)}`);
    if (!file.startsWith(root + sep)) throw new Error("Outside repository");
    const contents = await readFile(file);
    res.writeHead(200, { "Content-Type": mime[extname(file)] || "application/octet-stream", "Cache-Control": "no-store" });
    res.end(contents);
  } catch { res.writeHead(404); res.end("Not found"); }
});
await new Promise((r, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", r); });
const child = spawn(chrome, [
  `--remote-debugging-port=${debugPort}`, `--user-data-dir=${resolve(out, `profile-${Date.now()}`)}`,
  "--no-first-run", "--no-default-browser-check", "--disable-background-timer-throttling",
  "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows", "about:blank",
], { stdio: "ignore" });
child.on("error", (error) => console.error(error.message));
class CDP {
  constructor(url) {
    this.next = 0; this.pending = new Map(); this.events = [];
    this.ws = new WebSocket(url);
    this.open = new Promise((r, reject) => { this.ws.onopen = r; this.ws.onerror = reject; });
    this.ws.onmessage = ({ data }) => {
      const packet = JSON.parse(data);
      if (packet.id) {
        const pending = this.pending.get(packet.id);
        if (!pending) return;
        this.pending.delete(packet.id); clearTimeout(pending.timer);
        packet.error ? pending.reject(new Error(JSON.stringify(packet.error))) : pending.resolve(packet.result);
      } else this.events.push(packet);
    };
  }
  async call(method, params = {}) {
    await this.open;
    return new Promise((resolve, reject) => {
      const id = ++this.next;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout ${method}`)); }, 15000);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression) {
    const result = await this.call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }
  close() { this.ws.close(); }
}
let browser;
const pages = [];
const results = { started: new Date().toISOString(), environment: {
  platform: os.platform(), release: os.release(), cpu: os.cpus()[0]?.model,
  node: process.version, transport: "same-machine BroadcastChannel, 10 ms artificial push delay",
  independentMachines: false, physicalDisplayOnsetMeasured: false,
  browserFlags: "background timer/render/occlusion throttling disabled for controlled baseline; lifecycle scenarios explicit",
}, scenarios: [] };
results.environment.bundleSha256 = createHash("sha256").update(await readFile(resolve(root, "packages/jspsych/dist/index.browser.js"))).digest("hex");
const snapshot = `(() => {
  const probe = window.clockPrototypeProbe;
  let diagnostics; try { diagnostics = JSON.parse(document.querySelector('#diagnostics').textContent); } catch {}
  const mp = probe?.mp;
  return { message: document.querySelector('#message')?.textContent,
    hidden: document.querySelector('#stimulus')?.hidden, disabled: document.querySelector('#input')?.disabled,
    countdown: document.querySelector('#countdown')?.textContent, visibility: document.visibilityState,
    clock: mp?.clock.status(), diagnostics, rawLocal: probe?.rawNow(), timeOrigin: performance.timeOrigin,
    peers: mp?.getAll(), userAgent: navigator.userAgent, screen: { width: screen.width, height: screen.height, dpr: devicePixelRatio } };
})()`;
async function waitFor(page, predicate, timeout = 14000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const data = await page.eval(snapshot);
    if (predicate(data)) return data;
    await pause(50);
  }
  throw new Error(`Page wait timed out: ${JSON.stringify(await page.eval(snapshot))}`);
}
async function createPage(url, left) {
  const { targetId } = await browser.call("Target.createTarget", { url: "about:blank", newWindow: true });
  const window = await browser.call("Browser.getWindowForTarget", { targetId });
  await browser.call("Browser.setWindowBounds", { windowId: window.windowId, bounds: { left, top: 0, width: 700, height: 800, windowState: "normal" } });
  const list = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
  const page = new CDP(list.find((p) => p.id === targetId).webSocketDebuggerUrl);
  page.targetId = targetId;
  pages.push(page);
  await page.call("Runtime.enable"); await page.call("Page.enable");
  await page.call("Page.navigate", { url });
  return page;
}
async function pair(name, extra = "") {
  const session = `${name}-${Date.now()}`;
  const base = `http://127.0.0.1:${port}/examples/multiplayer-clock.html?probe=1&session=${session}&delay=10${extra}`;
  const a = await createPage(`${base}&id=a&skew=5000`, 0);
  await pause(250); // Intentionally different entry times.
  const b = await createPage(`${base}&id=b&skew=-3000`, 705);
  const ready = await Promise.all([a, b].map((p) => waitFor(p, (d) => d.message?.startsWith("Prepared."))));
  for (const d of ready) { assert.equal(d.hidden, true); assert.equal(d.disabled, true); assert.equal(d.clock.state, "ready"); }
  return { a, b, ready };
}
async function closePair(pair) {
  for (const p of [pair.a, pair.b]) {
    await browser.call("Target.closeTarget", { targetId: p.targetId }).catch(() => {});
    p.close();
  }
}
async function run(name, fn) {
  if (process.argv.includes("--freeze-only") && name !== "frozen/background lifecycle") return;
  console.log(`Browser scenario: ${name}`);
  const entry = { name, started: new Date().toISOString() };
  results.scenarios.push(entry);
  try { entry.evidence = await fn(); entry.pass = true; }
  catch (error) { entry.pass = false; entry.failure = error.message; console.error(`${name}: ${error.message}`); }
  await writeFile(resolve(out, "results.json"), JSON.stringify(results, null, 2));
}
try {
  let version;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { version = await (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json(); break; }
    catch { await pause(100); }
  }
  if (!version) throw new Error("Chrome DevTools unavailable");
  results.environment.browser = version.Browser;
  browser = new CDP(version.webSocketDebuggerUrl);
  await run("two-window future reveal/countdown/input gating", async () => {
    const p = await pair("baseline");
    try {
      const reveal = await Promise.all([p.a, p.b].map((page) => waitFor(page, (d) => d.message === "Shared countdown running")));
      reveal.forEach((d) => { assert.equal(d.hidden, false); assert.equal(d.disabled, false); });
      const schedule = reveal.map((d) => d.diagnostics.schedule);
      assert.deepEqual(schedule[0], schedule[1]);
      const observations = reveal.map((d) => d.diagnostics.observations[0]);
      const sharedCallbackDifference = Math.abs(observations[0].shared - observations[1].shared);
      assert.ok(sharedCallbackDifference <= 50, `Reveal shared callback difference ${sharedCallbackDifference} ms exceeds provisional 50 ms`);
      // Bracket remote reads in the reference page's monotonic axis; this is software consistency.
      const t1 = await p.a.eval("clockPrototypeProbe.mp.now()");
      const tb = await p.b.eval("clockPrototypeProbe.mp.now()");
      const t2 = await p.a.eval("clockPrototypeProbe.mp.now()");
      const midpointDisagreement = tb - (t1 + t2) / 2;
      assert.ok(Math.abs(midpointDisagreement) <= 50 + (t2 - t1) / 2);
      await p.a.call("Page.captureScreenshot", { format: "png" }).then((x) => writeFile(resolve(out, "baseline-a.png"), Buffer.from(x.data, "base64")));
      await p.b.call("Page.captureScreenshot", { format: "png" }).then((x) => writeFile(resolve(out, "baseline-b.png"), Buffer.from(x.data, "base64")));
      const finished = await Promise.all([p.a, p.b].map((page) => waitFor(page, (d) => d.message?.startsWith("Countdown finished"))));
      finished.forEach((d) => assert.equal(d.disabled, true));
      return { before: p.ready, reveal, finished, sharedCallbackDifference, midpointDisagreement, bracketWidth: t2 - t1,
        method: "Shared reveal timestamps and sequential reference-bracketed reads; software consistency, no independent remote ground truth or physical onset" };
    } finally { await closePair(p); }
  });
  await run("immutable accepted schedule", async () => {
    const p = await pair("mutation");
    try {
      await p.a.eval("clockPrototypeProbe.mp.update({schedule: {...clockPrototypeProbe.mp.get('a').schedule, deadline: clockPrototypeProbe.mp.get('a').schedule.deadline + 1000}})");
      const failed = await Promise.all([p.a, p.b].map((page) => waitFor(page, (d) => d.message?.includes("Accepted schedule changed"))));
      failed.forEach((d) => { assert.equal(d.hidden, true); assert.equal(d.disabled, true); });
      return failed;
    } finally { await closePair(p); }
  });
  await run("reference close", async () => {
    const p = await pair("reference-close");
    try {
      await browser.call("Target.closeTarget", { targetId: p.a.targetId });
      const failed = await waitFor(p.b, (d) => d.message?.startsWith("Stopped:"), 10000);
      assert.equal(failed.clock.state, "degraded"); assert.equal(failed.disabled, true);
      return failed;
    } finally { await closePair(p); }
  });
  await run("reference reload never replaces generation", async () => {
    const p = await pair("reference-reload");
    try {
      const original = p.ready[1].clock.reference;
      await p.a.call("Page.reload");
      const failed = await waitFor(p.b, (d) => d.message?.startsWith("Stopped:"), 10000);
      assert.equal(failed.clock.state, "degraded"); assert.deepEqual(failed.clock.reference, original);
      return { original, failed };
    } finally { await closePair(p); }
  });
  await run("event-loop interruption", async () => {
    const p = await pair("stall");
    try {
      await p.b.eval("(() => { const end = clockPrototypeProbe.rawNow() + 2500; while (clockPrototypeProbe.rawNow() < end) {} })()");
      const failed = await waitFor(p.b, (d) => d.message?.startsWith("Stopped:"));
      assert.equal(failed.clock.state, "degraded"); assert.equal(failed.disabled, true);
      return failed;
    } finally { await closePair(p); }
  });
  await run("frozen/background lifecycle", async () => {
    const p = await pair("freeze");
    try {
      const revealed = await waitFor(p.b, (d) => d.message === "Shared countdown running");
      assert.equal(revealed.disabled, false);
      await p.b.call("Page.setWebLifecycleState", { state: "frozen" });
      await pause(2500);
      await p.b.call("Page.setWebLifecycleState", { state: "active" });
      // CDP "active" can leave visibility hidden; foreground explicitly to resume RAF.
      const beforeForeground = await p.b.eval(snapshot);
      await p.b.call("Page.bringToFront");
      const failed = await waitFor(p.b, (d) => d.message?.startsWith("Stopped:"));
      assert.equal(failed.clock.state, "degraded"); assert.equal(failed.disabled, true);
      return { ...failed, revealed, beforeForeground, method: "Chrome CDP frozen->active->foreground transition after reveal; distinct from OS sleep or ordinary hidden tab" };
    } finally { await closePair(p); }
  });
  await run("calibration cancellation cleans outstanding request", async () => {
    const p = await pair("cancel");
    try {
      const before = p.ready[1].clock;
      const cancellation = await p.b.eval(`(async () => {
        try { await clockPrototypeProbe.mp.clock.ready({maxSampleAge: 0.001}); } catch {}
        const controller = new AbortController();
        const operation = clockPrototypeProbe.mp.clock.ready({signal: controller.signal});
        setTimeout(() => controller.abort(), 5);
        try { await operation; return {unexpectedSuccess:true}; }
        catch(error) { return {code:error.code, clock:clockPrototypeProbe.mp.clock.status(), diagnostics:clockPrototypeProbe.mp.clock.diagnostics()}; }
      })()`);
      assert.equal(cancellation.code, "cancelled"); assert.equal(cancellation.clock.state, "degraded");
      await pause(100);
      const slot = await p.b.eval("clockPrototypeProbe.transport.slot()");
      assert.equal(slot.$clock.request, undefined);
      assert.equal(cancellation.clock.revision, before.revision);
      return { before, cancellation, slot };
    } finally { await closePair(p); }
  });
  await run("adapter interruption/reconnect requires bounded revalidation", async () => {
    const p = await pair("reconnect");
    try {
      await p.b.eval("clockPrototypeProbe.transport.interrupt()");
      const failed = await waitFor(p.b, (d) => d.message?.startsWith("Stopped:"));
      assert.equal(failed.clock.state, "degraded"); assert.equal(failed.clock.reason, "reconnecting");
      await p.b.eval("clockPrototypeProbe.transport.resume()");
      const beforeRevalidation = await p.b.eval("clockPrototypeProbe.mp.clock.status()");
      assert.equal(beforeRevalidation.state, "degraded");
      const after = await p.b.eval("clockPrototypeProbe.mp.clock.ready()");
      assert.equal(after.state, "ready"); assert.equal(after.revision, failed.clock.revision + 1);
      assert.deepEqual(after.reference, failed.clock.reference);
      const final = await p.b.eval(snapshot);
      assert.equal(final.hidden, true); assert.equal(final.disabled, true); // Existing failed schedule never auto-restarts.
      return { failed, beforeRevalidation, after, final };
    } finally { await closePair(p); }
  });
  if (process.argv.includes("--long")) await run("explicit 75-second sample-age policy across a 60-second round", async () => {
    const p = await pair("long", "&duration=60&age=75000");
    try {
      const reveal = await Promise.all([p.a, p.b].map((page) => waitFor(page, (d) => d.message === "Shared countdown running")));
      const observed = [];
      for (let i = 0; i < 6; i++) {
        await pause(10000);
        const samples = await Promise.all([p.a, p.b].map((page) => page.eval(snapshot)));
        samples.forEach((d) => { assert.equal(d.clock.state, "ready"); assert.equal(d.clock.revision, 1); assert.ok(d.clock.uncertainty <= 50); });
        observed.push(samples);
        console.log(`60-second round checkpoint ${i + 1}/6: ready, revision 1`);
      }
      const finished = await Promise.all([p.a, p.b].map((page) => waitFor(page, (d) => d.message?.startsWith("Countdown finished"), 5000)));
      finished.forEach((d) => { assert.equal(d.disabled, true); assert.equal(d.clock.state, "ready"); });
      return { before:p.ready, reveal, checkpoints:observed, finished,
        policy:"Explicit age=75000; 200 ppm projected uncertainty<=50 through deadline; no mid-round correction or calibration", };
    } finally { await closePair(p); }
  });
} finally {
  results.finished = new Date().toISOString();
  await writeFile(resolve(out, "results.json"), JSON.stringify(results, null, 2));
  for (const p of pages) p.close();
  if (browser) { await browser.call("Browser.close").catch(() => {}); browser.close(); }
  child.kill(); server.close();
}
console.log(JSON.stringify(results.scenarios.map(({ name, pass, failure }) => ({ name, pass, failure })), null, 2));
console.log(`Browser diagnostics: ${resolve(out, "results.json")}`);
if (results.scenarios.some((x) => !x.pass)) process.exitCode = 1;
