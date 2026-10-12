# Real JATOS gate: transport works, precision criterion fails

Tested 2026-10-12 UTC on the supplied disposable study at `cortex.jatos.org`.
Two fresh independent Chrome browser contexts were used per run. The server loaded
the imported study, assigned distinct General Multiple workers, and sealed a
two-member group. Both runs completed five timestamp samples, then rejected the
participant calibration with `quality_rejected`. No thresholds were changed.

**Decision: the real deployment gate did not pass.** This state-transport prototype
does not meet the 50 ms uncertainty criterion on the tested client/server path.
Keep the clock as a separate review packet; Hawkins adoption remains deferred.
This is a failed measured gate, replacing the earlier access-unavailable status.

## Exact deployed packet

- jsPsych source: `e7ca9a9da931c910462323effc0f983a02d66264`.
- Adapter source: `e5a8ac9c8a97d3bc4bde4cdd29c335aac9512f9a`.
- Archive SHA-256: `8718c4b4b4d4b9cc9b79c9775d33c313ae4bab1f9461ac4fb8c5deae4e96eeeb`.
- Core browser asset SHA-256: `8d5143c6ff48cf9fbdaa67b9be2165be16ceb71b8e2cec8e607eddb5a41895f1`.
- Final harness source SHA-256: `9c8e777cd12874ae119233fb6b63a4af7345fc98d93ca82238c8c0ac562cb422`.

The second run fetched the embedded build manifest and independently SHA-256-hashed
all five deployed assets in **both** worker sessions. Both matched the companion
archive manifest exactly. The imported metadata was successfully usable at runtime;
the administrator's import messages were not observed. Source and archive were not
rebuilt or modified during these tests. The new harness and this report are separate
from the deployed packet and do not imply a new deployed frontend revision.

## Conditions and measured results

Client: Windows `10.0.26200`, Intel Core i7-8665U at 1.90 GHz, Node `v24.13.0`,
Chrome `154.0.8037.99`; screen 1280x720, DPR 1.5. Both workers were on one machine
in isolated browser contexts/cookie stores, in visible windows. The real service
reported JATOS `3.11.3`, HTTPS/h2 and Group Session WebSockets, remote address
`46.101.96.134`. Physical network medium, VPN/proxy, geographic server location,
independent-machine timing and physical onset were not established. Background
timer/render/occlusion throttling was disabled for the controlled baseline.

No artificial network delay was added. Client axes were deliberately skewed
+5,000/-3,000 ms, and the second window navigated 250 ms later. The actual batch
reported max active members 2, max total members 2, max total workers 100000,
and allowed General Multiple/General Single workers. Both groups were sealed.

| Run | UTC window | Worker / participant IDs | Group | Five RTT samples, ms | Best RTT/2, ms |
| --- | --- | --- | --- | --- | --- |
| First | 02:40:23-02:40:32 | 96/697, 97/698 | 134 | 818.9, 319.7, 333.5, 314.4, 307.6 | 153.8 |
| Repeat | 03:07:18-03:07:26 | 98/699, 99/700 | 135 | 935.0, 292.6, 291.7, 297.3, 291.3 | 145.65 |

The comparison is already decisive before adding drift/sample-age allowance:
estimated uncertainty exceeds the 50 ms ceiling by almost threefold. The initial
startup sample was slow, but removing that outlier cannot rescue either run because
even the best sample fails. Calibration completed within its bounded sample/attempt
and overall timeout budget; it rejected quality rather than misreporting a timeout.
The failed participant kept revision 0, no committed anchor and no reveal observation.
Screenshots confirm the stimulus remained hidden and practice input disabled.

The repeat also measured three current reference-participant study writes through
`mp.update()`: confirmation took 96.6, 96.9 and 95.7 ms. These measurements were
taken **after** calibration failed and after asset verification; they did not alter
the calibration samples. They wrote only a diagnostic field in this disposable
participant's study data. They are not a concurrent two-client throughput test.

The approximately 291 ms calibration RTT versus approximately 96 ms write-confirmation
duration is consistent with server-relayed state exchange plus serialized write/ack
queueing. This is an inference, not an instrumented decomposition: backend processing,
network transit and queueing were not separated. Application-boundary timestamps
deliberately include that queueing under the acceptance record.

RTT/2 is a provisional uncertainty estimate, **not a measured clock error or a measured
145-154 ms display disagreement**. The failure demonstrates inadequate accepted timing
quality, not that the underlying offset estimates necessarily have that much error.
No physical display onset was measured.

## Gate coverage

| Check | Status |
| --- | --- |
| Imported study loads; supported client/adapter APIs operate | Observed pass |
| Deployed manifest and all asset hashes match pinned packet | Verified on both repeat workers |
| Independent worker/participant IDs, shared group and sealed two-member roster | Observed pass in both runs |
| Five uniquely identified exchanges complete over actual persistent state | Observed pass; five valid sample log entries per participant |
| Calibration uncertainty <=50 ms | **Failed in both runs** |
| Hidden stimulus/disabled input after rejected calibration | Observed pass |
| Accepted immutable schedule, reveal, countdown and input cutoff on real JATOS | Unverified; calibration prerequisite failed |
| Real JATOS 60-second/explicit75-second age policy | Unverified; prerequisite failed |
| Real JATOS cancellation, backgrounding, interruption/reconnect, reference close/reload | Unverified; successful-readiness lifecycle scenarios not entered |
| Two machines, ordinary OS sleep/default background throttling, physical onset | Unverified |
| Server result saving | Unverified; prototype deliberately does not submit result data |

The harness stops additional worker scenarios when baseline feasibility fails;
`--full` does not bypass readiness or increase uncertainty. The 75-second policy
cannot repair this failure: a 62-second schedule needs initial uncertainty <=37.6 ms,
which is stricter than the failed short-round threshold. Timeouts or slower attempts
alone are therefore not the main configuration issue here.

## Reproduction and retained evidence

```text
node scripts/prototype-clock-jatos-browser.mjs WORKER_LINK --full
```

Use the operator-provided General Multiple link as `WORKER_LINK`. This launches
isolated actual Chrome windows; execution requires network/GUI permission in a
sandbox. It does not edit imported study assets, modify JATOS administration, or
change thresholds. Outputs include bounded network/error events, full bounded clock
diagnostics, snapshots, screenshots and source packet metadata under ignored `dist`.

- First raw result: `dist/jatos-clock/run-1791772823756/results.json`.
- Repeat with deployed asset verification and write timings:
  `dist/jatos-clock/run-1791774438620/results.json`.
- Repeat screenshots: `dist/jatos-clock/run-1791774438620/1-0.png` and `1-1.png`.

The page's preserved diagnostic JSON records `quality_rejected` before its cleanup
disconnect. A later direct status snapshot can show `disconnected`; that is not a
different cause of the failed calibration. All tested browser contexts were closed
after evidence capture. No study completion/result submission or administrative
cleanup was performed; disposable started runs may remain visible in JATOS.

## Recommended next decision

First determine whether the intended deployment can provide a lower-latency
client/server path, and run the same unchanged packet there. This would test
environment dependence without rewriting the clock or loosening its bounds.
For this tested path, a further transport/reference investigation is needed before
adoption: quantify queueing and assess a timestamped server reference or an optional
adapter exchange capability if supported. A different messaging transport might
remove storage/queue overhead, but it is not proven to meet the gate and still has
to obey backend transit delay and uncertainty assumptions.

Any such iteration needs a new bounded acceptance record and its own deployed
revision. Do not silently promote a wider uncertainty allowance or treat the
successful local-browser long run as real JATOS evidence. No core behavior, paid
study, Hawkins integration, adapter package or original archive was changed here.
