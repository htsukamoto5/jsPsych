# Shared-clock handoff — 2026-10-11

Session date is America/Indianapolis; late-session tests ran on 2026-10-12 UTC.

**Current decision:** retain the separate jsPsych clock prototype. Real JATOS
import, pairing and state exchanges work, but the tested deployment path failed
the unchanged 50 ms uncertainty gate twice. Hawkins integration remains deferred.
The next task is latency/transport investigation, not another blind scheduling run.

## Where the work lives

- Repository: jsPsych; branch `prototype/shared-clock-3694`.
- Push destination: `origin`, the author's fork `htsukamoto5/jsPsych`.
- Base: live PR #3694 head `1c3623b9133eb10ab011584545333276e8e509e4`, checked
  before branching and again during follow-up. No human maintainer review was present.
- Original plan: sibling `../multiplayer-test-experiments/MULTIPLAYER-CLOCK-PLAN.md`.
- Core clock: `packages/jspsych/src/modules/multiplayer/clock.ts`; session-owned
  transport integration in `session.ts`; public API is `jsPsych.multiplayer`.
- Backend investigation: sibling jspsych-multiplayer JATOS adapter. Its source
  checkout was left unchanged.

Local commits preceding this handoff:

| Commit | Work |
| --- | --- |
| `b66436e7` | Acceptance record, bounds and proceed/defer conditions |
| `f2b4ec77` | Core clock API, transport integration and deterministic regressions |
| `e7ca9a9d` | Scheduling demos, browser harness and pinned JATOS packaging |
| `13d1d96b` | Real JATOS harness and failed deployment-gate measurements |

## Completed today

Implemented bounded calibration against the lexicographically first member of a
sealed group, with reference page identity as generation. Clock data uses its own
`$clock` slot field; study `update()`/`replace()` writes preserve it. Requests retain
unique page/session/sequence IDs; duplicate/stale processing is idempotent and cleanup
does not recapture timestamps. No new adapter methods are required.

The API exposes `clock.ready()`, `clock.status()`, `clock.diagnostics()` and `now()`.
Readings use a local monotonic anchor, not Unix time. Readiness degrades on quality
expiry, suspension, connection changes and reference loss. No replacement reference
is chosen. Cancellation/programming-error cleanup and correction behavior have
regressions. Waiting for sealed membership is separate from unsupported capability.

Defaults remain: 10-second calibration, five samples/eight attempts, 50 ms estimated
uncertainty, 30-second sample age, modeled 200 ppm relative drift, 32 diagnostic entries.
The disposable 60-second demo explicitly selects `duration=60&age=75000` and forecasts
quality through the entire deadline. At a two-second lead, uncertainty must start
at <=37.6 ms. This is a provisional alternative to mid-round correction; default
age/uncertainty thresholds were not silently relaxed.

Verification: 523 core tests in 36 suites, eight snapshots, five schedule tests,
focused clock type checking and jsPsych build passed. Full monorepo commands encountered
the dependency/import issues documented in the results report; do not claim those
checks passed. No merges, PR-scope changes or paid-run modifications were made.

Actual two-window Chrome checks passed scheduling/input gating, immutable schedules,
cancellation, reconnect/revalidation, reference close/reload and suspension. The
explicit 60-second run passed on its recorded bundle. A freeze test exposed a demo
failure UI that depended on RAF; visibility handling and a bounded quality monitor
fixed it. Both interim failures and the final successful regressions are retained.
Ordinary OS sleep/default background throttling and physical onset remain unverified.

## Real JATOS outcome

The operator imported our archive into a disposable study on `cortex.jatos.org`.
Chrome was used directly through DevTools, with independent browser contexts and
General Multiple workers. The server reported JATOS 3.11.3. Both groups were sealed,
with max active/total members 2/2. No artificial network delay was added.

| Group | Workers / participants | Best exchange RTT | Minimum RTT/2 estimate |
| --- | --- | --- | --- |
| 134 | 96/697, 97/698 | 307.6 ms | 153.8 ms |
| 135 | 98/699, 99/700 | 291.3 ms | 145.65 ms |

Both non-reference clients completed five samples, then rejected calibration with
`quality_rejected`. Neither committed an anchor or revealed the stimulus; input
remained disabled. Three later reference study-write confirmations took 95.7–96.9 ms.
The cause is consistent with relay latency plus serialized state-write queueing,
but network, server processing and queueing have not been separately measured.
RTT/2 is an uncertainty estimate, not measured display desynchronization.

Both deployed asset sets were independently hashed and matched the pinned packet.
Real JATOS schedules, the long round, subsequent lifecycle scenarios, two-machine
timing and server result saving remain unverified because readiness failed. The
harness deliberately stops there instead of bypassing the gate.

## Preserve these identities and evidence

**Deployed source stays `e7ca9a9da931c910462323effc0f983a02d66264`**, even though
later commits add harnesses/reports/handoff. Adapter source is
`e5a8ac9c8a97d3bc4bde4cdd29c335aac9512f9a`.

Archive SHA-256:
`8718c4b4b4d4b9cc9b79c9775d33c313ae4bab1f9461ac4fb8c5deae4e96eeeb`.
The [preserved packet manifest](evidence/shared-clock-2026-10-11-packet-manifest.json)
is pushed with the documentation. Its pending deployment fields describe build time;
the reports above record the subsequent failed gate.

These original artifacts remain local and ignored by Git:

- `dist/shared-clock-prototype.jzip`, `.jas` and `.manifest.json`.
- `dist/jatos-clock/run-1791772823756/results.json` and screenshots.
- `dist/jatos-clock/run-1791774438620/results.json` and screenshots.
- `dist/browser-clock/run-1791770056630/`: successful long browser run.
- `dist/browser-clock/run-1791770516209/`: final eight-scenario browser regression.
- `dist/shared-clock-measurements.json`: actual adapter source / simulated server run.
- `dist/session-backups/shared-clock-2026-10-11-backup.zip`: selected original packet
  and evidence, excluding browser profiles/cookies. Copy this backup to private
  storage if resuming on another machine; it is not uploaded with the source branch.
- `dist/session-backups/jatos-test-access.json`: operator-provided worker link,
  retained locally, not committed or published.

Do not regenerate/overwrite the tested archive merely to update the reports.
The packager requires clean committed source trees and makes a new manifest/archive
identity; a changed implementation needs its own package and a new import.

## Next session

1. Read the [acceptance record](multiplayer-clock-acceptance.md) and
   [real JATOS report](multiplayer-clock-jatos-validation.md). Confirm branch/worktree,
   inspect live #3694 feedback before any behavior change, and preserve the tested packet.
2. Identify the intended deployment/network path. If a lower-latency test server or
   clients near this server are available, test the same unchanged packet there.
   Record the network medium, VPN/proxy and host location when actually known.
3. Instrument the state path before changing the estimator: request enqueue and
   adapter dispatch, reference observation/reply enqueue/dispatch, receiver observation,
   write confirmation, retries and queue wait. Assess whether piggybacked acknowledgments
   or another supported exchange path remove avoidable delay. Do not treat state as a queue.
4. Investigate a supported timestamped server reference or optional adapter exchange
   only if needed. No suitable supported JATOS server timing endpoint has been established.
   Direct messaging may remove storage overhead, but still needs measurement and contract review.
5. Write a new bounded acceptance/iteration record before another implementation attempt.
   Keep thresholds explicit. Do not promote wider uncertainty simply to obtain a pass.
6. Once readiness passes, run real schedules and lifecycle checks, then two machines
   when available. Preserve the new source/archive hashes with every result.
7. Only after the real deployment gate passes, plan Hawkins adoption separately.
   Response cutoff and in-flight-response reconciliation still need their own design
   and tests. No recording extension, automatic reference replacement or continuous
   correction belongs in this bounded packet by default.

Reproduction after obtaining the operator link:

```text
node scripts/prototype-clock-jatos-browser.mjs WORKER_LINK --full
```

The Chrome harness already exists; Playwright installation is unnecessary for the
current tests. GUI/network execution needs sandbox escalation. Fresh workers/group
are used per scenario. Disposable started runs may still appear in JATOS; no
administrative cleanup or result submission was performed.

Supporting records: [API/results](multiplayer-clock-results.md),
[browser validation](multiplayer-clock-browser-validation.md), and
[real JATOS validation](multiplayer-clock-jatos-validation.md).
