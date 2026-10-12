# Bounded shared-clock prototype acceptance record

Recorded before implementation, 2026-10-11. Branch `prototype/shared-clock-3694`
starts at the fetched live [PR #3694](https://github.com/jspsych/jsPsych/pull/3694)
head `1c3623b9133eb10ab011584545333276e8e509e4`; clean initial worktree, no human
maintainer feedback. Plan source: sibling `multiplayer-test-experiments/MULTIPLAYER-CLOCK-PLAN.md`.

## Reference and transport

Use the lexicographically smallest participant ID in the sealed roster. Shared
reference identity is `(sessionId, participantId, generation)`; generation is the
reference page-load identity from core presence metadata. Local calibration revision
is separate. Time is milliseconds on that reference's `performance.now()` axis,
not Unix time. No automatic replacement, including after a reference reload.

The [supported JATOS client API](https://www.jatos.org/jatos.js-Reference.html)
documents persistent Group Session patches, local mirrored reads, confirmation,
and direct/broadcast messages, but no timestamped server-clock sampling endpoint.
Server heartbeat acknowledgments and HTTP Date are not adequate timestamped samples.
Therefore choose participant timing without a new service or adapter requirement.
Inspected sibling adapter main `e5a8ac9c8a97d3bc4bde4cdd29c335aac9512f9a`:
participant-keyed `groupSession.set`, three conflict retries, mirrored `getAll`,
sealed roster, channel status. Existing adapters remain structurally unchanged.

Use an optional core-owned `$clock` field beside `$mp`, `session`, and `scopes` in
each participant slot. Study writes cannot overwrite it. Keep one uniquely identified
request per requester, and one reply per roster member on the reference. Requests
persist until reply/ack; replies persist until matching ack, replacement request, or
expiry. Combined pushes preserve outstanding exchanges. IDs include requester page
identity, a page-local connection epoch, and a sequence. Never infer delivery from a push promise alone.

Capture t1 immediately before enqueueing request; t2 when the reference first reads
that request; t3 immediately before enqueueing its reply; t4 on requester's first
matching reply observation. Queueing and conflict retries are part of elapsed time.
Duplicate replies do not reset t4 or count twice. Retries keep original timestamps.
Offset = ((t2-t1)+(t3-t4))/2, network RTT = (t4-t1)-(t3-t2).
Choose minimum-RTT sample; uncertainty = RTT/2 plus assumed drift. This assumes
nonnegative transit delays; asymmetry is unresolved, and uncertainty is provisional.

## Bounds and quality

- Calibration: 10,000 ms overall, including sealed-group wait and write queues;
  1,000 ms per exchange, five valid samples, at most eight attempts. Enough to
  reject several delayed samples without an open-ended lobby.
- Ready: estimated uncertainty <= 50 ms; sample age <= 30,000 ms. These are
  display/countdown prototype thresholds, not stimulus-onset guarantees.
- Drift allowance: 200 ppm relative rate, adding 0.0002 ms/ms to uncertainty.
  Revalidate explicitly after quality expiry, outage, backgrounding, or >2,000 ms
  event-loop gap. Watchdog interval 250 ms. Wall time is used only to detect sleep
  when monotonic time pauses; wall-clock jumps degrade rather than change readings.
- Reads advance at local monotonic rate. Reject a recalibration correction larger
  than 50 ms within a generation; smaller backward corrections preserve the old
  anchor (no stalls/slew). Forward corrections may jump by <=50 ms; report revision.
  Degraded reads throw by default; explicit opt-in permits last-anchor extrapolation.
- Diagnostics: retain at most 32 samples/events; wire reply count <= sealed roster
  size; reply expiry 12 seconds. No perpetual recalibration traffic.
- Abort/disconnect cancels pending calibration. Reconnect requires fresh calibration;
  reference departure/reload invalidates readiness and never chooses another member.

## Budget and proceed/defer

Three implementation/validation iterations: (1) estimator/protocol/lifecycle and
early JATOS access check, (2) failure fixes and two-client scheduling demonstration,
(3) final regression checks and measurement report. Do not loosen thresholds silently.
Proceed with a reviewable prototype if deterministic tests meet these bounds and
two clients demonstrate an immutable shared schedule despite skew/late entry.
Recommend inclusion in #3694 only after real JATOS passes the same gate; if access
is unavailable, report it unverified and recommend a separate PR. Defer deployment
if transport loses exchanges, timing exceeds limits, or budget ends with failures.

Test offsets/skew, delay asymmetry/outliers, duplicate/stale replies, retries,
combined concurrent study writes, drift/age, wall jumps, suspension/stalls,
cancellation/timeouts, reconnect and reference loss. Demonstration publishes start
2 seconds ahead and a 5-second deadline; validates round/reference and acknowledges
the immutable schedule before start. Late schedule delivery fails explicitly.
Stimulus/input stay gated until start. Software callback observations and simulated
ground truth are separate from physical display onset, which is not measured.

No recording extension, Hawkins integration/enforcement, paid-run edits, merges,
reference replacement, or continuous correction.

## Follow-up validation packet (2026-10-11)

Explicitly reopen the bounded packet for three follow-up iterations: audit/status
fixes; two-window browser validation and any fixes; final regressions and deployment
handoff. Existing thresholds remain unchanged. Waiting for a supported adapter's
sealed roster is `waiting_for_group`; an adapter without `group()` is truly
`unsupported` for this fixed-reference strategy and rejects immediately.

Resolve the 60-second-round mismatch through a separately opted-in **75,000 ms**
sample-age policy in the disposable demonstration only. Keep the default 30,000 ms
and uncertainty ceiling 50 ms. Before accepting a 2-second-ahead/60-second schedule,
require sample age plus its full 62,000 ms horizon <=75,000 ms and current uncertainty
plus `62,000 * 0.0002` <=50 ms (initial uncertainty <=37.6 ms). Thirteen seconds
of age margin cover calibration/preparation; the existing calibration is bounded
to ten seconds. At 200 ppm, the complete 75-second age allowance adds at most
15 ms modeled drift uncertainty. High-RTT transports that cannot reserve this
headroom must reject the long schedule; do not increase the uncertainty threshold.

This alternative avoids mid-round corrections and reference serving outages;
it is a provisional, explicitly selected horizon policy, not evidence that all
devices drift at <=200 ppm. Demonstrate monotonic reads/quality through a 60-second
simulation, rejection of inadequate headroom, and early degradation on suspension,
connection loss or reference departure. Browser and real JATOS results determine
whether the alternative is usable. Hawkins remains deferred even if it passes.
