# 03 — Phase 3: Harden (Security · Resilience · Edge Cases)

Owner: methodology wrapper. Consolidates the 27 red-team findings (C-01…C-27)
into controls; it does not re-run the red-team.

## Security architecture (9 domains)

| Domain | Threat | Required control | Enforcement point | Residual risk |
|---|---|---|---|---|
| Authorization + identity | Shared service identity, forged actor, confused deputy, agent exceeding user rights, broken SoD | OBO for interactive calls; job SP for scheduled work; immutable `actor_id`/`actor_type` + delegated identity; task/entity/operation grants; proposer cannot approve above configured threshold | AI Gateway, supervisor tool wrapper, admin registry, commit proc | OBO propagation / group membership can be misconfigured → preflight + audit reconciliation |
| Commit + consistency | False commit, over-allocation, double allocation, stale proposal, replay | Stored proc is sole DML boundary; revoke direct target writes; aggregate-root `FOR UPDATE` in canonical order; invariant recomputation; mandatory `expected_version`; deterministic idempotency key (UNIQUE-enforced) | Lakebase roles, proc, constraints, txn tests | Hot roots may contend → monitor wait time + abort rate |
| Config governance | User redirects writes / weakens validation; config changes mid-run | User settings vs admin security registry; immutable versions + canonical SHA-256; run pins `config_version`; registered change types determine mandatory locks/invariants | `genie_automations_config`, admin registry, supervisor, proc | Privileged admin compromise → approval + audit |
| Containment | Runaway agent makes many individually-valid writes | Hierarchical kill switches (env/task/config/entity/operation/amount); shadow/canary; velocity + cumulative-value limits | Gateway/tool wrapper + proc rechecks authoritative limits | Limits mis-tuned → default conservative + near-breach alerts |
| Injection + ingest | Files/text instruct the agent; malformed xlsx/archives exhaust resources; probabilistic extraction fabricates values | All files land in governed Volume first; MIME/size/archive/macro checks; deterministic xlsx/csv parse; images/text are data only; confidence gate + human confirm; typed schemas | Upload BFF, ingest router, parser sandbox, UC validation | OCR ambiguity remains → low-confidence data cannot commit |
| Audit | Repudiation; Lakebase commit succeeds but Delta publish fails | Target + audit + outbox atomic; canonical SHA-256 for source/proposal/result; immutable Delta copy; outbox reconciliation | Lakebase txn, publisher Job, UC retention | Delta copy is async → surface publication lag |
| Chase | Duplicate/unauthorized messages, consent violation, over-escalation | Transactional send outbox; idempotent delivery key; suppression/consent/quiet-hours/rate/escalation caps; dry-run/approval mode | Chase Job + channel adapter | Provider receipts imperfect; inbound replies deferred |
| Ops + observability | Credential expiry, hidden backlog, lock saturation, missing traces | OAuth refresh + bounded pools; health probes; correlated `run_id/change_id/trace_id`; alerts for lock waits, outbox age, sync lag, auth failures | Serving, Jobs, Lakebase metrics, MLflow/UC traces | Monitoring pipeline can fail → heartbeat / dead-man alerts |
| Evaluation | Model regression routes unsafe tools / fails to refuse | Versioned eval datasets; deterministic security/state suite + agent routing/refusal suite; promotion blocked on regression | CI/CD + MLflow evaluation | Test-set blind spots → feed production failures back in |

**Threat-model decision owned here:** the trigger to adopt the **signed audit
hash-chain** (doc 01 §6) is *either* real financial data entering *or* an
external party gaining workspace/Delta write access.

## Resilience design

- **Circuit breakers:** open after 5 consecutive dependency failures; probe
  after 30 s; exponential backoff with jitter. **No retry around unknown commit
  outcomes until idempotency status is queried.**
- **Fail closed:** no commit unless actor, config hash, approval, current
  version, aggregate lock, invariant, and containment limit all verify.
  Credential failure disables writes + sends. **Outbox backlog above the named
  age threshold pauses chase and blocks period-seal — but does not pause
  commit** (commit already wrote audit + outbox atomically in Lakebase). Stale
  Delta may serve read-only answers with a freshness warning, never drive
  commits or chase eligibility (those read Lakebase).
- **Graceful degradation:** Tier 0 normal → Tier 1 Genie/Delta reads only →
  Tier 2 stage-but-no-commit → Tier 3 status + export only. External-channel
  failure retains outbox entries without duplicate sends.
- **Containment:** default shadow → allowlisted canary entities → bounded
  production. Limits apply independently and cumulatively by
  env/task/config/entity/operation/amount. Kill-switch blocks new commits +
  sends but preserves reads + audit. Recovery = incident review + reconcile
  outbox/audit/target, then rollback of nonfinancial state OR explicit
  compensating financial entries — **never destructive history edits.**
- **CQRS:** Lakebase authoritative for interactive command state; Delta the
  governed async analytical/audit projection.
- **Concurrency:** pessimistic aggregate-root locking protects cross-row
  invariants; optimistic row versions protect approved intent. Lock waits,
  deadlocks, and txn duration are first-class metrics.

## Edge-case register

| Condition | Expected behavior | Test hook |
|---|---|---|
| xlsx with formulas, hidden sheets, merged headers | Apply pinned workbook policy; warn or reject ambiguity | Golden workbook corpus |
| CSV encoding/delimiter drift | Detect only within allowlist; else request confirmation | Parser property tests |
| Screenshot has low-confidence amount | Stage only; require human correction | Mock confidence boundary |
| File contains prompt injection | Content never changes instructions or tool selection | Adversarial document suite |
| Same idempotency key retried after timeout | Return original outcome; no second event | Network-fault injection |
| Two proposals over-allocate one remittance | One commits; one fails after locked recomputation | Concurrent transaction test |
| Expected row version is stale | Reject entire atomic proposal | Version-race fixture |
| Multi-root proposal locks roots differently | Proc canonicalizes order; no deadlock | Parallel randomized test |
| Delta/audit publisher unavailable | Commit durable; outbox retries; lag alarm | Publisher outage test |
| Chase run overlaps manual trigger | One delivery per deterministic send key | Concurrent trigger test |
| Channel rejects / rate-limits | Retry eligible failures; permanent failure recorded | Adapter fault simulator |
| Kill switch activates mid-run | Uncommitted work aborts; committed work remains audited | Transaction barrier hook |
