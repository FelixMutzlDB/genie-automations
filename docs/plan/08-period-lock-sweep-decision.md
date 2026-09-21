# 08 — Period-lock fork: contention_sweep() design + decision rule (settled)

Outcome of the Claude↔GPT debate (1 round, converged). Settles *how* to build
`contention_sweep()` and *how* to decide open decision #1 (period-lock scope).
This is the design the sweep implements; the sweep produces the numbers, an
approved commit-latency SLO + a validated fan-in decide the winner.

> **Scope (see [09](09-automation-model-and-glossary.md)).** This fork is a
> property of the **reconciliation automation type specifically** — the type
> that has a `(subsidiary, period)` aggregate invariant. Automation types with
> **no cross-record aggregate invariant do not need this decision at all**. The
> "period" here is the reconciliation automation's **config-defined grouping**
> (for a recurring reconciliation it aligns with the schedule). **Fan-in N is a
> config-driven / pilot-scale input — NOT a plan constant** (DEUTZ's entity
> count is pilot-specific). Run the sweep across N and decide **per automation
> config** when that automation's realistic peak is known.

## The three designs (not two)

The current `commit_change` does `UPDATE subsidiary_period SET generation=... WHERE status='open'`
on every commit — which takes a period **row lock**, so today's "remittance-only"
is secretly lock-both. Kill that confound: build three procs identical in every
respect except the period-row interaction.

| Design | Period-row interaction on commit | Seal | Property |
|---|---|---|---|
| **B — lock-both** | `SELECT … subsidiary_period … FOR UPDATE`, require `status='open'`, bump generation under it | flips status under the same lock | safe by construction; all commits on one period serialize |
| **A′ — share-lock** *(max-concurrency candidate)* | `FOR SHARE` on the period row **after** the remittance lock; verify `status='open'` **as part of / after** the locking read; **no generation update on the commit path** | `FOR UPDATE` → `sealing` → recompute sealed position → `sealed` | concurrent commits don't block each other; seal blocks behind in-flight commits and new commits block behind seal — crossing impossible by lock compatibility |
| **A-naive — control (NOT a candidate)** | no period touch at all | — | known-broken; **must** show seal-miss>0. Validates the detector. |

**Why A′ over an append-only marker/epoch gate:** an append-only insert conflicts
with nothing, so it does not serialize against the seal's status flip → the epoch
gate needs a "verify no commit crossed" step that is exactly the subtle money-race
we're avoiding. A′'s proof is one line of lock compatibility (`FOR SHARE` ⟂
`FOR UPDATE`), with no verification step to get wrong. Observability comes from the
**existing audit + outbox rows** (keyed by `commit_seq`, carry the period) — no
marker table.

**A′ hard constraints (must hold or it degrades to B / is unsafe):**
1. Line-item commits must **not** update `subsidiary_period.generation` (that upgrades to an exclusive lock and recreates B's serialization). Generation is derived at seal.
2. A′ is safe **only** because the aggregate invariant is enforced at **seal**, not per-live-commit. `FOR SHARE` is sufficient precisely because concurrent commits share no live invariant (they don't need each other's uncommitted effects).

## How to build the sweep

- **Three procs** differing only in the period interaction (locking is the sole variable).
- **Throughput/latency experiment (B vs A′):** N concurrent proposals on ONE hot period-root, each a **distinct remittance** (seeded headroom so nothing rejects); a **same-remittance control** should show ~identical latency across designs (harness-noise check). Levels **1/5/20/50** — but 1/5 vs 20/50 being "operating point" vs "stress ceiling" is set by the **automation's config + pilot scale**, not assumed. Barrier immediately before the proc call; ≥10 warm-up + ≥30 measured rounds/level, randomized design order, **scale-to-zero disabled** (cold start swamps signal). A second realistic distribution: mostly-distinct roots with a small hot-root fraction.
- **Measure server-side, separately:** period-lock-wait (`clock_timestamp()` around the `FOR SHARE`/`FOR UPDATE` acquisition — the delta *is* the lock-wait, don't infer it), txn duration p50/p95/p99/max, commits/s, deadlock + retry rates, seal latency; keep reject-path latency out of the throughput runs. **Add: multixact/lock overhead on the A′ `FOR SHARE` row at the stress ceiling** (the one place A′ could surprise us).
- **Seal-miss experiment (SEPARATE from throughput):** for A-naive first, use a **deterministic test hook/barrier** — pause after the commit reads `open` but before it commits, run seal in that window; if the detector does NOT report a miss, the harness is invalid. THEN ≥1000 randomized-jitter races per design. Classify every committed allocation as (in sealed Σ) XOR (rejected post-seal); a **seal-miss = committed-but-silently-absent-and-not-rejected**, OR a commit accepted after the period went non-open. Expect misses>0 for A-naive, 0 for A′ and B.

## Decision rule (settled)

- **Default to B** (simpler, safe-by-construction; ties for money go to B).
- **A′ is eligible only with:** (1) its mechanistic lock-compatibility proof, AND (2) empirical seal-miss = 0 across all runs (with the detector validated by A-naive), AND (3) zero invariant/audit/outbox violations, AND (4) deadlocks ≈ 0 or bounded-retry within budget.
- **Promote A′ over B only if** B **materially** breaches the ratified commit-latency SLO — B exceeds the SLO p99 in **≥3 independent runs** at a justified peak, **or** B **fails to clear the credible peak arrival rate with margin** (absolute test — A′ merely being faster is irrelevant), while A′ passes.
- `seal-miss = 0` is **necessary, not sufficient** — finite testing is corroboration, not proof; A′ must also carry the mechanistic argument.

## Two inputs the verdict depends on — pin BEFORE running the sweep

1. **Commit-latency SLO.** Not 750 ms by assertion. A commit is one step of a multi-second agent turn — **derive** the commit p99 budget from the end-to-end turn SLA (rough intuition: a few hundred ms to leave turn headroom; do not hard-code 300–500 ms without deriving it).
2. **Realistic fan-in for the specific automation.** How many concurrent corrections credibly hit **one** period-root at peak? This is a function of the **automation's config + pilot scale**, discovered per deployment — NOT a plan constant. Low fan-in (a human + the agent on one grouping) → **B almost certainly wins**. High fan-in (many actors converging on one shared root) → **A′ becomes the likely winner** and the seal proof is worth paying for.

## Prediction

Both partners predict **B wins** at low, realistic fan-in. The single measurement
that flips it to A′: B breaching the ratified p99 budget at realistic fan-in on
one root while A′ stays within it and passes the deterministic seal-boundary test
— or the automation's config producing genuinely high single-root fan-in.
