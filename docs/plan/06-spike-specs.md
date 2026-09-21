# 06 — Spike Specs

Owner: write-path engine. QC fixes marked `[fix]`. These are the only things to
build now; generalized P1–P4 waits on their results. Scaffold lives under
`spikes/`.

## Spike 1 — serving-endpoint → Lakebase stored-proc atomic commit

**Goal:** prove OBO identity reaches the write, atomicity of promote + audit +
outbox, idempotency replay safety, aggregate-root lock behavior, and **measure**
contention to settle the period-lock decision.

**`[fix]` Prerequisite (must close before step 2): the Lakebase credential /
identity model.** Lakebase `current_user` is the *connecting* principal — an SP
unless per-user DB credentials are used. Define and prove the mechanism by
which the verified end-user actor is:
- derived from the OBO token at the Gateway/endpoint,
- passed to the proc as a **server-attested `actor_id` param that agent
  tool-args cannot forge**, and
- recorded in `audit_event.actor_id` distinct from the DB principal
  (`db_principal`).

**Steps:**
1. Deploy `commit_change` proc + seed remittance / period roots (headers exist
   by FK).
2. Thin serving tool invokes proc under OBO; assert `audit_event.actor_id` =
   acting user, not the SP; assert actor is not caller-forgeable.
3. Kill the connection mid-txn → assert no partial state (all-or-nothing).
4. Replay the same idempotency key → assert single ledger effect (UNIQUE-
   enforced idempotency record).
5. Two concurrent proposals over-allocating one remittance via disjoint
   invoices → assert exactly one commits, one aborts on invariant.
6. **Contention run:** 1 / 5 / 20 / 50 concurrent proposals on one
   `(subsidiary, period)`, **lock-both vs remittance-only+generation-gate**;
   capture p50/p95/p99 lock-wait + txn-duration, deadlock/abort rate,
   seal-miss count.

**Exit criteria (measurable):** OBO actor correct 100%; zero partial commits;
replay effect count = 1; over-allocation blocked 100%; **seal-miss = 0** for
remittance-only+gate; deadlock-retry resolves within 3 attempts.

**Forces a design change if:** OBO can't propagate to the proc (→ scoped SP +
compensating attribution, escalate); any partial commit (→ move commit fully
into Postgres); seal-miss > 0 or generation-advance not atomic-by-construction
(→ lock-both fallback); lock-both p99 > ratified interactive budget AND
remittance-only unsafe (→ redesign seal as async with explicit period-freeze).

## Spike 2 — deterministic xlsx/image ingest

**Goal:** prove deterministic xlsx + csv accuracy on messy inputs, hostile-file
rejection, endpoint-vs-Job thresholds for interactive image paste, and set the
per-modality accuracy bars.

**Steps:**
1. Corpus of ~30 messy xlsx (multi-sheet, merged headers, totals rows, hidden
   rows, locale numbers, date serials) + csv, each with ground-truth canonical
   rows; measure field-level exact-match.
2. Hostile set: zip-bomb, `.xlsm` macro, encrypted, wrong-magic-byte, 2M-row
   sheet → assert all rejected within resource caps (no OOM/hang).
3. Image paste: same tables as screenshots through vision FM in-endpoint —
   measure latency + payload size and extraction accuracy.
4. Locate the endpoint-vs-Job cutover by file size / row count.

**`[fix]` Metric:** maintain **separate ground-truth datasets per modality**;
do NOT compute a cross-population "deterministic − 2 pts" bar across different
input populations. Set a **per-modality** accuracy bar.

**Exit criteria:** deterministic xlsx/csv field exact-match **≥ 99.5%**
well-formed, **≥ 98%** messy-but-legal (ambiguous → human-confirm, never silent
wrong); hostile files 100% rejected within caps; interactive image p95 latency
**< 8 s** under a set payload ceiling; per-modality probabilistic bar set, below
which auto-commit is disallowed (**human-confirm is mandatory for the
probabilistic path regardless — see doc 02 §5**).

**Forces a design change if:** deterministic xlsx < 98% messy (→ structural-
parse redesign / stronger human-confirm gating); image path can't meet
interactive latency (→ image is Job-only + async notify); a hostile file evades
caps (→ all parsing moves to a sandboxed Job, no in-endpoint parse).
