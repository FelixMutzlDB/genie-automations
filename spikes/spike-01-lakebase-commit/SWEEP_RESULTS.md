# contention_sweep() — live results (genie-automations Lakebase, PG17, 1 CU)

Ran `harness/run_sweep.py` per docs/plan/08. Three period-variants differing ONLY
in the period-row interaction; distinct-remittance workload on ONE hot period.
`SWEEP_ROUNDS=3`. Instance was 1 CU (not tuned) — treat absolute ms as
directional; the **B-vs-A′ gap** is the signal.

## Throughput / latency (per-commit)

| Variant | N | p50 ms | p95 ms | p99 ms | period lock-wait (mean ms) | commits/s |
|---|---|---|---|---|---|---|
| **B** (lock-both)   | 1  | 26.9 | 32.4 | 32.4 | 0.15 | 16.5 |
| B                   | 5  | 43.7 | 54.6 | 59.1 | 6.15 | 72.4 |
| B                   | 20 | 139.9 | 203.7 | 216.2 | 72.8 | 147.1 |
| B                   | 50 | 302.0 | 480.1 | 495.2 | 215.2 | 173.6 |
| **A′** (share-lock) | 1  | 27.2 | 31.7 | 31.7 | 0.17 | 17.1 |
| A′                  | 5  | 43.5 | 52.0 | (250.6*) | 0.45 | 75.9 |
| A′                  | 20 | 93.2 | 104.9 | 112.7 | 1.08 | 184.0 |
| A′                  | 50 | 186.5 | 199.7 | 200.6 | 4.37 | 239.2 |

*A′ N=5 p99 outlier is a single cold sample (lock-wait stayed 0.45 ms) — noise, not contention.

**Reading it:**
- **Low fan-in (N=1–5): B ≈ A′.** Period lock-wait is ~0–6 ms; the designs are
  indistinguishable. At the realistic single-root fan-in for reconciliation
  (~1–5) **B is perfectly adequate** and simpler.
- **High fan-in (N=20–50): A′ wins clearly.** B's period lock-wait dominates
  (73 ms → 215 ms as everything serializes on the period row); A′ stays flat
  (~1–4 ms, `FOR SHARE` commits don't block each other). A′ p99 ~200 ms vs B ~495 ms
  at N=50; throughput 239 vs 174 commits/s.

This is exactly the shape docs/plan/08 predicted.

## Seal-race (correctness)

| | deterministic barrier | randomized jitter |
|---|---|---|
| **A-naive** (control) | **misses = 4/4** — detector fires ✅ | — |
| **B** | 0/4 | 0/40 |
| **A′** | 0/4 | 0/40 |

The A-naive control leaking 4/4 **validates the seal-miss detector** (it can catch
a real miss). With the detector proven, **B and A′ both show zero seal-misses** —
A′'s `FOR SHARE`(commit) ⟂ `FOR UPDATE`(seal) boundary holds empirically, as its
one-line lock-compatibility proof says.

## Verdict — deferred by design (docs/plan/08)

Both designs are **safe** (seal-miss = 0, detector-validated). The choice is
purely performance, and the data says:
- **Default B** unless the reconciliation automation's **realistic single-root
  fan-in** is high. Pin two inputs to render the call:
  1. **Ratified commit-latency SLO** (derived from the agent-turn SLA).
  2. **Realistic single-root fan-in at pilot scale.**
- If fan-in stays ~1–5 → **B** (simpler, safe, within budget). If it's routinely
  ≥20 on one period → **A′** (its concurrency advantage is real and measured).

Note: these ms are on a cold-ish 1 CU instance; re-run on the pilot's tier with
scale-to-zero disabled before ratifying against the SLO.
