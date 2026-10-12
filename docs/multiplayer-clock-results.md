# Shared-clock prototype results and handoff

The prototype is on `prototype/shared-clock-3694`, based on the fetched live
PR #3694 head `1c3623b9133eb10ab011584545333276e8e509e4`. The initial worktree was
clean. [Acceptance record](multiplayer-clock-acceptance.md) was written before coding.
Three bounded iterations covered implementation, protocol/demonstration fixes,
and final checks. The follow-up packet explicitly adds an optional 75-second age
policy for the disposable 60-second demonstration; defaults remain unchanged.
See [browser validation, audit findings, and the real JATOS gate](multiplayer-clock-browser-validation.md).
No PR was merged, and neither sibling
repository nor paid-run behavior was modified.

**Recommendation: separate PR.** Deterministic clock and existing-state transport
criteria pass, including the actual JATOS adapter source against a simulated server.
Real JATOS timing remains unverified; real two-window Chrome rendering is now tested.
The deployment acceptance gate
for expanding #3694 has not passed. Keep that API review unblocked. A future separate
clock PR should preserve this implementation's adapter compatibility and complete
the deployment gate before claiming deployment precision.

## Implemented API

```javascript
await jsPsych.multiplayer.clock.ready({
  timeout: 10000,
  maxUncertainty: 50,
  maxSampleAge: 30000,
  signal: controller.signal,
});
const sharedMs = jsPsych.multiplayer.now();
const status = jsPsych.multiplayer.clock.status();
const diagnostics = jsPsych.multiplayer.clock.diagnostics();
```

Both clients call `ready()`, including the reference. The reference must be running
the prototype and ready to serve samples. Requires a sealed group and a connected
session. Readiness is an observation at a point in time; check quality during a
scheduled interaction and stop on degradation. Clock status distinguishes `idle`,
`waiting_for_group` (supported adapter, awaiting seal), `unsupported` (no adapter
`group()` capability), `calibrating`, `ready`, and `degraded`. Unsupported capability
rejects immediately without starting calibration traffic; waiting for a group keeps
the same bounded timeout/cancellation contract and can continue when the group seals.
Errors are `MultiplayerClockError` with a `code`; invalid bounds are `TypeError`.
An overlapping calibration rejects rather than starting a second exchange stream.

`now()` uses the reference's `performance.now()` axis, **not Unix epoch time**.
Before calibration or after degradation it throws. Explicit
`now({ allowDegraded: true })` permits last-anchor extrapolation for diagnostics,
including after disconnect; it is not a readiness assertion. Reads stay monotonic
within the fixed reference generation. An outage/resume, visibility change, event-loop
gap >2 seconds, wall/monotonic divergence >2 seconds, excessive age/uncertainty, or
reference loss degrades readiness. Wall time never determines the shared reading.
The 250 ms watchdog and synchronous read checks detect these conditions; they cannot
run during a frozen event loop. There is no promise that every short stall is detected.

Reconnect requires explicit fresh calibration. A reference reload/departure locks
the clock in reference-loss failure; no successor is selected. Revalidation keeps
reference identity and increments the local revision. Corrections >50 ms reject.
Small forward corrections can jump by at most 50 ms; small backward corrections
retain the previous offset and add the retained difference to uncertainty so
countdowns neither stall nor silently change rate. Drift is a provisional 200 ppm
relative allowance, not a measured device guarantee.

The core-owned `$clock` slot field is separate from study scopes. Concurrent
`update()`/`replace()` calls preserve it, and clock-only snapshots do not notify
study subscriptions. Adapters need no new methods. A request/reply/ack exchange has
one outstanding requester ID, immutable original timestamps through retries,
one reference reply per sealed member, and bounded expiration. Five valid samples
are required within eight attempts, 1 second per attempt, 10 seconds overall.
Calibration does not await a potentially stuck backend write. Diagnostics retain
at most 32 entries. A successful sample is acknowledged once; stale/duplicate replies
cannot consume the current request. Reference replies are removed on acknowledgment,
replacement request, departure, or 12-second expiry.
One served-ID high-water mark per sealed member prevents identical or older requests
from recapturing timestamps after cleanup. Request IDs include a page-local connection
epoch and sequence, so an explicit disconnect/connect does not reuse them. Programming
errors preserve their original exception and clear the pending attempt timer.

## Evidence

Validated 2026-10-11, Windows workstation, Node v24.13.0/npm 11.15.0. Deterministic
Jest tests inject independently known local offsets, rates and delivery times.
The source-level demonstration runs two isolated JavaScript VM contexts on one
machine, loading current core and sibling JATOS adapter TypeScript source. The
sibling source matches live main `e5a8ac9c8a97d3bc4bde4cdd29c335aac9512f9a`.
Its existing browser dist was older; the preparation script rebuilds the relevant
adapter/utility sources directly without changing the sibling checkout.

| Measurement | Result | Interpretation |
| --- | --- | --- |
| Deterministic symmetric 20/20 ms transport, 8,000 ms skew | 0 ms disagreement | Known simulation ground truth; five samples |
| Deterministic asymmetric 10/70 ms transport | 30 ms bias; >=40 ms estimated uncertainty | RTT does not resolve asymmetry |
| Source-level JATOS simulation, follow-up run | 15.34 ms clock / 15.33 ms countdown disagreement at a common observation | Actual adapter, simulated persistent Group Session server |
| Independent simulated clock error | 15.29 ms | Compared with the harness's common Node monotonic source |
| Software reveal callback difference | 15.95 ms | Both callbacks on one workstation; timer jitter included |
| Countdown difference at each client's own reveal | 0.65 ms | Observations at different real times; not same-time agreement |
| Estimated uncertainty after scheduling | 44.74 ms | Minimum RTT 88.60 ms plus age/drift allowance |
| Simulated JATOS exercise | 30 writes, one injected conflict, duplicate notifications | Concurrent study writes preserved; five valid samples |

The final simulation intentionally separates clients by 8 seconds, delays each
client/server leg by 10 ms (20 ms participant-to-participant nominal one-way),
and enters the second client's schedule 250 ms later. Application queues and write
acknowledgments add delay. The first retry sample had RTT 172.66 ms; the estimator
selected the smallest RTT. Results vary with host scheduling and are not statistical
latency characterization. The complete bounded log is in generated
`dist/shared-clock-measurements.json` and is reproducible with the command below.

Corrected timestamp agreement is a consistency check. The independent simulated
error uses a known common harness source, which remote browsers do not have.
Neither demonstrates simultaneous physical display onset. Browser DOM/reveal
callback timestamps do not measure display scanout, GPU buffering, or refresh phase.

Tests cover skew, asymmetric delay, large delay/RTT outliers, duplicates and stale
replies, expired attempts/retries, sample age at completion, drift/quality expiry,
combined writes, concurrent study replacements, backward/large corrections,
wall jumps, paused monotonic sleep, stalls and visibility notifications, cancellation,
disconnect/reconnect, reference departure/reload, unsupported membership, acknowledgment
cleanup, bounded diagnostics and timer cleanup. Schedule tests cover reference/round
validation, immutable acceptance, late failure and reveal/input gating.

## Verification commands and limits

```text
npm test -- --config packages/jspsych/jest.config.cjs --runInBand tests/multiplayer
npm test -- --config packages/jspsych/jest.config.cjs --runInBand
node --test scripts/prototype-clock-schedule.test.mjs
npm exec -- tsc --noEmit --target es2020 --lib dom,esnext --moduleResolution node --esModuleInterop --skipLibCheck packages/jspsych/src/modules/multiplayer/index.ts packages/jspsych/tests/multiplayer/clock.test.ts
npm run build --workspace jspsych
node scripts/prototype-clock-jatos.mjs
node scripts/prototype-clock-prepare-jatos.mjs
node scripts/prototype-clock-browser.mjs --long
```

All 523 jsPsych tests passed in 36 suites, including 160 multiplayer tests (137
original + 23 prototype/transport tests); eight snapshots and five separate schedule
tests passed. Focused clock/core module type check and jsPsych's JS/declaration/CSS
build passed. `git diff --check` passed.

The required root commands were attempted in the initial packet, including escalation after Turbo's
sandbox TLS initialization failed. Full `npm test` fails before collecting tests
because root workspace dependency links cannot resolve `@jspsych/config/jest`.
`npm run tsc` fails on missing `@jspsych/config/tsconfig.core.json` and package links;
`npm run build` builds jsPsych successfully, then fails resolving `@jspsych/config`
from test-utils. The existing full jsPsych TypeScript project also reports unresolved
`jspsych/src/timeline/util` imports in plugin-instructions and plugin-reconstruction.
These unrelated environment/import issues remain; full repository verification is
not claimed. Failed TypeScript tasks emitted untracked JS files; those generated
files were removed, preserving source and user work.

## Browser and deployment handoff

The browser demo was exercised in actual Chrome windows using the reproducible
DevTools harness. Exact bundle hashes, artifacts, results and conditions are in the
[browser validation report](multiplayer-clock-browser-validation.md). To repeat manually,
serve the repository root (`python -m http.server 8765 --bind 127.0.0.1`). Open two
visible windows on the same origin, within 10 seconds of each other:

- `http://127.0.0.1:8765/examples/multiplayer-clock.html?session=clock-1&id=a&skew=5000&delay=10`
- `http://127.0.0.1:8765/examples/multiplayer-clock.html?session=clock-1&id=b&skew=-3000&delay=10`

Use a fresh session name per run. The deterministic two-member local roster is a
development transport, not production grouping. Leave both windows visible because
backgrounding intentionally invalidates readiness. Confirm a 2-second future reveal,
input gating, one shared 5-second deadline, reference identity, five calibration
samples, and bounded diagnostics. Closing the reference should stop the other client;
backgrounding should stop rather than silently extrapolate. Reloading into an old
group is not a supported recovery route.

The default 30-second age threshold does **not** cover a 60-second round. The
explicit disposable alternative is `duration=60&age=75000` on both demo URLs. It
keeps uncertainty <=50 ms and checks the whole horizon before publishing/accepting
the schedule: age plus time to deadline <=75 seconds, uncertainty plus 200 ppm
modeled drift over that horizon <=50 ms. At a two-second lead, initial uncertainty
must be <=37.6 ms. The default is unchanged; no automatic resampling or corrections
occur during the long round. Both the deterministic 200 ppm drift test and actual
browser long run passed. This provisional drift assumption still needs deployment
and device evidence before Hawkins adoption.

For deployment, import generated `dist/shared-clock-prototype.jzip` into a disposable
JATOS installation (metadata and asset directory also exist separately). It is a group
study with a single component and maximum two active/total members. The packaged page
uses the real JATOS adapter automatically; `jatos.js` is supplied by JATOS. Start two
independent study workers/windows, then repeat on two machines. Capture both displayed
JSON diagnostics and the network/device conditions; test channel interruption,
reference close/reload and backgrounding. Reject late schedules/commits; no stimulus
is revealed on a failed schedule. Rebuild the core and regenerate assets after source
changes. `node scripts/prototype-clock-prepare-jatos.mjs` regenerates both assets and
the import archive with forward-slash ZIP entry names. It uses .NET compression on
Windows and Python's standard-library zipfile on other platforms. Build artifacts
are intentionally untracked.

The preparation script now requires clean, committed jsPsych and adapter source
trees. It embeds `build-manifest.json` with both Git revisions, build environment,
policy and asset/input hashes. The companion `dist/shared-clock-prototype.manifest.json`
also records the finished archive's SHA-256. Retain that manifest with all real
JATOS test results; do not identify this prototype by the original PR-head SHA alone.

**Real JATOS gate: unverified.** No deployment URL/access was available, and no local
JATOS listeners were found at ports 9000/9001/8080/8081. The supported API/source
investigation and simulated adapter run do not validate remote server timing,
authentication, import compatibility, browser suspension behavior, or result saving.
The [JATOS client reference](https://www.jatos.org/jatos.js-Reference.html) supports
the persistent state transport; it does not document a timestamped server sampling
endpoint. No undocumented endpoint, HTTP Date clock, or new service was assumed.

Automatic reference replacement, continuous correction, recording extension,
Hawkins adoption and response reconciliation/enforcement remain deferred. The demo's
practice input cutoff is only a disposable demonstration, not a paid-study policy.
