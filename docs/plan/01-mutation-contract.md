# 01 — Data-Consistency + Mutation Contract

Owner: write-path engine. QC fixes from the cross-review are folded in and
marked `[fix]`.

## 1. Proposal state machine

One row per proposed change in `proposed_changes` (Lakebase).

| From → To | Trigger | Guard |
|---|---|---|
| `staged` → `validated` | validate pass | all platform-minimum + task validations pass; `config_version_hash` pinned |
| `staged`/`validated` → `rejected` | validation fail / reviewer reject | terminal; reason + rule id recorded |
| `validated` → `approved` | human approver | approver ≠ proposer above materiality (SoD); diff + lineage shown (no blind approve) |
| `approved` → `committed` | stored proc success | atomic; sets `commit_seq` |
| `committed` → `published` | outbox→Delta ack | reconciler confirms Delta row present |
| any non-terminal → `revoked` | explicit revocation / validity policy | see `[fix]` below |

- **Approval and commit are proposal-level and atomic `[fix]`.** A proposal
  commits in full or not at all. Rows that fail per-row validation are
  **quarantined and form a NEW proposal** — there is no partial promotion of a
  subset of a proposal's rows.
- **`[fix]` No silent expiry on supersession.** A proposal pinned to an
  immutable `config_version_hash` does **not** expire merely because a newer
  config version exists. Instead an explicit **revocation/validity policy**
  applies: a proposal is `revoked` only by (a) an operator/reviewer action, or
  (b) a config version being explicitly **retired** (not merely superseded)
  for a stated reason. The commit proc re-checks the pinned version is still
  `active` (not `retired`) under lock; a retired version → `revoked`.

## 2. `commit_change` stored procedure

Trusted capability code maps `change_type → {roots, invariant_policy}` — **not**
the user Task Spec (closes C-01). Isolation: **READ COMMITTED**.

1. `BEGIN`.
2. Resolve `change_type` → set of aggregate roots + invariant policy (server-side).
3. **`[fix]` Idempotency is enforced by a UNIQUE constraint / insert of an
   idempotency record — not a read-then-check.** Attempt to insert the
   `idempotency_key` into `committed_idempotency`; a duplicate-key violation
   means a prior commit exists → **return the prior result (no-op)**. This
   replay lookup happens **before** the `state = approved` check so a replay of
   an already-committed proposal is a safe no-op even after state churn.
4. Lock the `proposed_changes` row `FOR UPDATE`; assert `state = approved` and
   pinned `config_version` is `active`.
5. `SELECT … FOR UPDATE` **all aggregate roots in canonical `(root_type,
   root_id)` order** (deadlock-free). Root headers exist by FK invariant, so
   the lock target is always present.
6. **Re-read children under the lock** (allocations/lines). Parent-lock-before-
   child converts READ COMMITTED's phantom exposure into a safe read. **All
   allocation DML flows through this proc; direct target-table DML is revoked.**
7. Recompute the aggregate invariant from authoritative Lakebase state
   (over-allocation: Σ allocations ≤ remittance total; reconciled-position at
   seal). Reject on violation (C-06/C-07).
8. **Mandatory `expected_version` check on every mutated row** (lost-update
   guard, orthogonal to the lock). Mismatch → abort `stale`.
9. Apply diff; bump per-row `entity_version` + derived root totals; insert
   immutable `audit_event`; insert `outbox` row — **all in this transaction**.
10. `COMMIT`. On deadlock/serialization abort → bounded retry **reusing the
    same deterministic idempotency key** so a retry cannot double-write.
11. Emit lock-wait + txn-duration metrics per commit.

**Deterministic idempotency key** = `hash(task_id, entity_key, diff,
config_version_hash)`. This is the single definition referenced everywhere
(commit replay, deadlock retry, and the P0/P3 "duplicate" gates).

### Aggregate roots
- **Over-allocation** (Σ allocations ≤ remittance total) → root = the **remittance**.
- **Reconciled-position / sum-correctness** → root = the **(subsidiary, period)** reconciliation header.
- Pick the **narrowest root that fully contains the invariant**.

## 3. Period-lock decision

**`[fix]` The spike selects between two _proven-safe_ designs on performance
only — it never waives locking.**

- **Primary — remittance-only lock + period generation/status gate.** Line-item
  allocation corrections lock only the remittance. Correctness requires that
  **every allocation atomically advances the `(subsidiary, period)`
  generation counter**, and that a **seal operation locks the period header and
  verifies the generation/status under lock**. `seal-miss = 0` is a
  *necessary-not-sufficient* empirical check — the guarantee is by
  construction (atomic generation advance), the spike measures whether the
  cheaper locking is worth it.
- **Fallback — lock-both-roots.** Every allocation that can move the period
  invariant locks both the remittance and the period header.

**Decision rule (Spike 1):** adopt remittance-only+gate **iff** (a) the
generation-advance is atomic by construction AND seal-miss = 0 across all runs,
AND (b) lock-both p99 txn-duration under simulated cut-off exceeds the ratified
interactive txn budget (placeholder 750 ms — see doc 07). Otherwise lock-both.

## 4. Per-consumer consistency

| Consumer | Read source | Isolation / freshness | Tolerated lag | Fail-closed rule |
|---|---|---|---|---|
| Interactive UI (edit/approve) | **Lakebase** | read-your-writes | 0 | never read Delta for a write decision (C-19) |
| Validation / `prepare_change` | **Lakebase** | committed | 0 | current-state read = Lakebase, not lagging Delta |
| Commit (proc) | Lakebase under lock | serialized-on-root | 0 | abort on invariant/version fail |
| Chase | Lakebase (obligations) | committed | seconds | suppress send if position uncertain |
| Genie / dashboards | Delta | eventual | ≤ sync SLO | UI labels "as of &lt;sync ts&gt;"; block period-seal while un-synced commits pend |
| Audit (system-of-record) | Delta (from outbox) | append-only | ≤ SLO | see §5 |

## 5. Outbox → Delta publication + reconciliation

- Outbox rows carry `commit_seq` + idempotency key + canonical payload hash.
- Publisher ships at-least-once; Delta audit upsert **dedups on idempotency key**.
- **`[fix]` Do NOT assume `commit_seq` is contiguous.** A Postgres sequence
  gaps on rollback and can commit out of order across concurrent transactions.
  Reconciliation uses a **transactional publication watermark + gap-tolerant
  reconciliation** (every committed row is eventually published and matched by
  idempotency key; the watermark tracks the highest fully-published prefix),
  **not** a strict-contiguity assertion that would false-alarm.
- Dead-letter queue for un-shippable rows; backlog age is an SLO.
- **`[fix]` Fail-closed scope (C-20):** if outbox backlog age > threshold
  (named config — see doc 07) OR a real gap is detected, **pause chase AND
  block period-seal**. It does **NOT** pause commit — the commit already wrote
  `audit_event` + `outbox` atomically in Lakebase, so Delta lag ≠ audit loss.

## 6. Audit integrity

- **Now:** every `audit_event` stores a **canonical payload SHA-256** (stable
  field ordering). The hash column is laid down from day one.
- **Adopt signed hash-chain (`prev_hash`) + independently-anchored checkpoints**
  when **either** trigger fires: (a) real (non-synthetic) financial data
  enters, or (b) an external party gains workspace/Delta write access. Because
  the hash column exists now, the chain is a **backfill, not a migration**.
- Trigger ownership: recorded as the Phase-3 threat-model decision (doc 03).

## 7. Reconciler-never-mutates (C-21)

The reconciler and all analytics/Genie paths are **read-only** on Delta. They
may write to a separate `recon_findings` table and raise alarms, but must
**never** `UPDATE`/`DELETE` audit or ledger rows. Enforced by grants
(append-only on audit; no write grant on ledger for the recon principal).
