# Shared-clock browser validation and deployment gate

Real JATOS follow-up is now measured: import/pairing and deployed asset identity
passed, but calibration quality failed in two independent groups. See the
[real JATOS report](multiplayer-clock-jatos-validation.md). The access-unavailable
section below describes the earlier local-browser packet, not the current gate status.

This is a separate prototype review packet on `prototype/shared-clock-3694`.
The plan, acceptance record, core clock/session code, JATOS adapter source, and
disposable demo were reviewed before this follow-up. Hawkins integration,
paid-run behavior, merges, automatic reference replacement, recording extension,
and continuous correction remain deferred.

## Selected implementation review

This is a selected protocol/lifecycle review, not a completed independent audit.
The persistent requester slot retains one unique request through backend retries;
core `sendLatest()` serializes combined writes and preserves `$clock` beside study
scopes. The JATOS adapter patches the participant key, retrying the same key/value
on version conflicts; shared state is not treated as a message queue.
Matching replies clear the pending exchange before resolution, so duplicates
cannot count a sample twice or consume a later outstanding request. Acknowledgment
and cleanup are distinct from successful push completion.

Follow-up regression fixes preserve one served-ID watermark per sealed member,
preventing reply expiration from recapturing timestamps for the same request and
rejecting older session-epoch/sequence replays after a newer request was served.
A page-local session epoch prevents request-ID reuse across explicit API reconnects.
The calibration `finally` block resolves any pending exchange to clear its timer,
including programming-error routes. Cancellation does not change the calibration
revision. Reference page generation remains fixed; close/away degrades reads and
reload changes are rejected without selecting another member.

Corrections retain a local monotonic anchor. Backward corrections preserve the old
offset and add the retained difference to uncertainty; forward corrections are
limited to 50 ms, and larger corrections fail explicitly. No mid-round correction
was used in the long browser demonstration. `waiting_for_group` now distinguishes
pending sealed membership from `unsupported`, which means the adapter lacks the
sealed-membership capability required by this prototype.

## Reproduction and browser conditions

```text
npm run build --workspace jspsych
node --test scripts/prototype-clock-schedule.test.mjs
node scripts/prototype-clock-browser.mjs --long
```

The browser script uses Node's built-in HTTP/WebSocket APIs and Chrome DevTools;
there is no automation-library download. It launches an isolated disposable Chrome
profile and two actual browser windows, serving the repository on
`127.0.0.1:8776`. Set `CLOCK_CHROME` to another Chrome executable if needed.
It closes only its own isolated browser. Every run saves full bounded clock logs,
scenario snapshots, a core-bundle SHA-256, and baseline screenshots beneath ignored
`dist/browser-clock/run-<timestamp>/`. Retain that JSON with this packet.

Test device: Windows `10.0.26200`, Intel Core i7-8665U CPU at 1.90 GHz,
Node `v24.13.0`, Chrome `154.0.8037.99`, screen 1280×720, device pixel ratio 1.5.
Both windows reported `document.visibilityState = visible` during baseline.
Transport was same-machine `BroadcastChannel`, with 10 ms artificial delay before
each participant push. Client axes were deliberately skewed +5,000/-3,000 ms;
the second client entered 250 ms later. No physical network, independent machine,
or real JATOS server was involved in these browser measurements.

Background timer/render/occlusion throttling was disabled for this controlled
baseline. The interruption scenarios explicitly froze/resumed a page and blocked
its event loop for 2.5 seconds. These are real browser lifecycle exercises, but do
not establish ordinary hidden-tab timing, OS sleep behavior, or device drift rates.

## Browser results

Initial six-scenario run on 2026-10-12 01:50:55–01:51:18 UTC passed: shared future
reveal/countdown, DOM input gating, immutable accepted schedule, reference close,
reference reload, event-loop stall, and frozen/background lifecycle. Its raw JSON
is `dist/browser-clock/results.json`; screenshots are in the same directory.
The shared reveal-callback difference was 0.35 ms. Sequential reads of client B
bracketed by client A's shared readings differed from the bracket midpoint by
0.35 ms, with a 2.20 ms bracket width. Participant B's estimated uncertainty was
11.40 ms initially and 12.78 ms at the five-second deadline.

These are software consistency observations on one device. Reveal timestamps use
each client's calibrated shared estimate; the reference-bracket method also has
remote read/automation ordering uncertainty. Neither independently measures remote
clock accuracy or physical display onset. The screen snapshots document rendering,
not scanout timing or refresh phase. Values are single-run results, not statistical
latency characterization or precision guarantees.

The updated nine-scenario run passed on 2026-10-12 01:54:16–01:55:45 UTC. Its
identifier is `run-1791770056630`; raw evidence is
`dist/browser-clock/run-1791770056630/results.json`. Core browser-bundle SHA-256:
`b7182fcacddf825b576c10c6f6de52e6cb8f5842120c90b917c1107b10993d1d`.
This supersedes the preliminary six-scenario run for the reviewed core fixes.

| Updated run check | Observed result |
| --- | --- |
| Five-second shared reveal callback difference | 1.00 ms |
| Reference-bracketed read midpoint disagreement | 2.15 ms; bracket width 12.90 ms |
| Participant B estimated uncertainty, preparation/deadline | 11.14 / 12.54 ms |
| Calibration cancellation | `cancelled`, no revision increment, outstanding wire request cleared |
| Channel interruption/reconnect | `reconnecting` degradation; recovery remains degraded until explicit calibration; same reference, revision 1→2 |
| Explicit 60-second round | Both ready at six 10-second checkpoints and deadline; revision remains 1 |
| Long-round reveal callback difference | 0.05 ms; same software-consistency limits |
| Long-round final reference/participant sample age | 62,606 / 62,268 ms |
| Long-round final estimated uncertainty | 12.52 / 24.20 ms, both below 50 ms |
| Long-round exchange/correction behavior | Five participant samples, no mid-round resampling or revision/correction |

The long run kept the accepted schedule unchanged and closed input at its deadline.
The channel-recovery run kept the failed demo stimulus/input gated after successful
clock revalidation; clock recovery does not itself resume an experiment.

The final core adds an older-request epoch/sequence replay guard. Its separate
eight-scenario browser regression passed on 2026-10-12 02:01:56–02:02:22 UTC,
artifact `dist/browser-clock/run-1791770516209/results.json`, core bundle SHA-256
`8d5143c6ff48cf9fbdaa67b9be2165be16ceb71b8e2cec8e607eddb5a41895f1`.
Final short-run reveal-callback difference was 0.05 ms; reference-bracketed read
midpoint disagreement was 0.75 ms with a 4.40 ms bracket width. The 60-second
evidence above belongs to the explicitly identified earlier bundle: that age policy
and its horizon guard did not change, but the long run was not repeated against
the final replay guard. Do not combine the two hashes into one validation claim.

Two intervening freeze-scenario attempts failed the harness's expectation of a
`Stopped` UI message: `run-1791770272053` (seven other scenarios passed) and
`run-1791770347362` (freeze only). Their failure JSON is retained. Chrome's
`frozen→active` transition left the page hidden even after `Page.bringToFront`;
the core correctly reported degraded/suspended and the pre-start stimulus/input
remained gated, but hidden-page animation frames did not update the message.
This exposed the demo's dependence on animation frames for updating failure UI.

The disposable demo now has a visibility-change handler and a 250 ms clock-quality
monitor, cleaned up on failure, deadline, or page exit. These detect and gate
degradation; they do not resample or correct the clock. A targeted follow-up
`run-1791770471850` passed. The final full run freezes **after reveal**, verifies
input was enabled beforehand, then verifies input becomes disabled and the
stimulus hidden after active/resume even when page visibility remains hidden.
During a completely frozen event loop no JavaScript handler can execute; gating
occurs once execution resumes. Ordinary OS sleep/default background throttling
still remain unverified.

The immutable-schedule case modifies the accepted deadline before start; both
windows stop without exposing the stimulus. Reference close produced
`reference_away`; reference reload produced `reference_lost` with the original
shared identity. Stall produced `suspended`; freeze/resume recorded visibility and
suspension events and stopped input. A degraded clock requires fresh calibration;
that does not automatically restart a failed accepted schedule.

Input checks inspect the disposable button's disabled state before reveal and at
deadline, plus stimulus visibility. This is prototype DOM gating, not a Hawkins
response-policy or in-flight-response reconciliation test.

## Explicit policy for a 60-second round

The default 30,000 ms sample-age bound remains unchanged. It cannot cover a
60-second round from one initial calibration. The disposable demonstration instead
requires explicit `duration=60&age=75000` on both clients. It rejects 60 seconds
without that named age choice. Before publishing and accepting an immutable
schedule, it forecasts quality through the deadline: projected sample age must be
at most 75,000 ms and projected uncertainty at most 50 ms, using the existing
200 ppm relative-drift allowance.

A two-second lead plus a 60-second round consumes 62,000 ms and 12.4 ms of drift
budget. Initial uncertainty must therefore be at most 37.6 ms, less whatever extra
age accumulated during preparation. A roughly 90 ms minimum-RTT sample from the
earlier simulated JATOS measurement would fail this horizon gate. Increasing the
age ceiling therefore does not make a poor deployment calibration acceptable.

This is a justified, explicitly chosen prototype alternative to mid-round
revalidation. It preserves the immutable reference/anchor throughout the round,
checks quality on reads, and stops on visibility change, stall, outage, reference
loss, or uncertainty expiry. The 200 ppm bound is provisional, not measured on
these devices. Hawkins adoption still needs deployment/device evidence and an
agreed route for mid-round degradation; passing this demo does not approve adoption.

## Real JATOS: unverified, exact next run

No deployment URL, authenticated JATOS session, API token, or independent worker
links were provided during this validation. Direct loopback checks of ports
9000, 9001, 8080, and 8081 returned `ECONNREFUSED`. No installation, network service,
or paid study was changed to manufacture access. Actual archive import, JATOS
pairing/state conflicts/channel recovery, independent-worker timing, two-machine
timing, and server result saving remain **unverified**.

The generated assets load `jatos.js` in the document head, wait for `jatos.onLoad`,
and obtain worker-link options from `jatos.urlQueryParameters`. This follows the
[supported client reference](https://www.jatos.org/jatos.js-Reference.html).
Archive layout and metadata were compared with the documented
[JZIP/JAS schema](https://www.jatos.org/JATOS-Study-Archive-JZIP); matching that
schema is not an observed successful import.

To execute the remaining gate, provide an authorized disposable JATOS instance URL
and authenticated browser access with permission to import a new study and launch
two workers, or have its operator perform this run and return the artifacts:

1. Rebuild core and run `node scripts/prototype-clock-prepare-jatos.mjs`. Import
   regenerated `dist/shared-clock-prototype.jzip` into a new disposable study.
   Record the JATOS version and import messages. Do not overwrite a paid study.
2. Use two independent GeneralSingle worker sessions in separate browser profiles,
   or two distinct personal worker links supported by that disposable batch.
   Verify distinct worker/study-result IDs, a common group/session, and exactly two
   sealed members. Avoid launching both clients as the same worker. Start within
   ten seconds. Set `skew=5000` and `skew=-3000` through the worker links.
3. Run the five-second schedule first. Save both JSON diagnostic displays before
   reveal, after reveal, and at deadline. Confirm equal reference/generation and
   immutable schedule, hidden stimulus/disabled input before start, and disabled
   input at the shared deadline. Record preparation and lateness failures.
4. Repeat with explicit `duration=60&age=75000` in both worker links. Preserve the
   forecast guard result and clock status around 30 seconds and at deadline. A
   failing horizon guard is a recorded deployment failure, not permission to loosen
   uncertainty or drift thresholds.
5. For fresh disposable groups, background one worker, interrupt/restore its network,
   close the reference, and reload the reference. The packaged component is
   intentionally `reloadable:false`; to exercise a real reference reload rather
   than JATOS's reload-denial policy, enable reload only in a separate disposable
   clone. Confirm degradation and fixed identity, bounded fresh calibration after
   recovery, and no automatic restart of a failed schedule.
6. If DevTools is available, use the optional `probe=1` link to inspect the demo
   `clockPrototypeProbe.mp` and inject a schedule mutation or late delivery; keep
   this inspection on the disposable study. Capture errors plus gated DOM state.
7. Repeat on two machines where available. Record OS/browser/version, CPU/power
   state, screen refresh setting, wired/Wi-Fi/mobile network, VPN/proxy, JATOS
   host/location, and artificial delay/skew separately from real conditions.

The demo does not call `jatos.submitResultData` or end the study. Save diagnostics
manually from both workers (and browser network/server logs if available); do not
claim result persistence from the on-screen JSON. A recording extension remains
outside this packet. Physical onset measurement would require independent
instrumentation and remains unverified even after an ordinary remote browser run.

Recommendation remains a separate clock PR and separate review packet until these
deployment gates pass. No Hawkins integration or paid-run change follows from the
same-machine browser results.
