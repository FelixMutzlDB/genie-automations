# 04 — Phase 4: Optimize (Coverage · Phases · Gates)

Owner: methodology wrapper. QC fixes marked `[fix]`.

## Coverage map

| Capability | Phase | Status |
|---|---:|---|
| Formless supervisor, identity propagation, one guarded write slice | P0 | In scope |
| Stage, validate, approve, atomic commit, audit/outbox, Delta projection | P1 | In scope |
| Chat text, image, CSV, and hard-required XLSX ingest | P2 | In scope |
| Scheduled/manual chase with one outbound channel | P3 | Simplified; dry-run before live |
| Second configured instance/type + hardening | P4 | In scope; measure code changes honestly |
| Genie questions over governed consolidated tables | P1–P2 | In scope |
| Inbound chase reply handling | — | **Deferred**: channel-specific workflow |
| Multi-channel production delivery | — | **Deferred** beyond first adapter |
| Cross-period consolidation | — | **Deferred** |
| Multi-currency conversion / FX policy | — | **Deferred** |
| Fully config-only *arbitrary* new task types | — | **Deferred**; only registered types are config-only |
| Native Genie file upload as official submission | — | **Excluded**; exploratory only |

## P0 — riskiest slice first

Replaces the "chat reaches Genie" vanity milestone. Each item is tied to an
observable success criterion.

| P0 item | Observable success criterion |
|---|---|
| Synthetic proposal through supervisor with preserved user identity | Audit actor = authenticated caller; caller-supplied identity is ignored |
| Human preview/approval | No financial commit occurs before approval |
| Stored-procedure commit | Target, audit, and outbox change atomically |
| Concurrent conflicting allocation | Exactly one commit; aggregate never exceeds remittance |
| Retry after ambiguous timeout | Exactly one financial event |
| Unauthorized/stale/malicious request | Rejected with zero target mutation |
| App-free invocation | Supervisor completes the same slice without the App |

**`[fix]` Batch-path identity note:** for the scheduled-Job path the actor is
the **service principal + system/batch attribution** — that is a **PASS**, not
an identity-preservation failure. The "actor = authenticated caller" assertion
applies to the interactive OBO path only.

## Version pinning / reproducibility

Pin exact Python/Node dependencies in committed lockfiles; serving model
name/version; registered agent version; prompt/tool-contract version; Task-Spec
schema version; immutable `config_version` + hash; proc migration version;
parser version + xlsx policy; eval dataset/scorer versions. `.env.example`
lists every resource variable with empty defaults — no profile, workspace URL,
endpoint ID, secret, or catalog baked in. Every trace and audit event records
all applicable versions.

## Phase success criteria + hard eval gates (release-blockers)

Two layers per phase: **deterministic** money/state/security asserts +
**agent-eval** routing/refusal.

| Phase | Observable outcome | Release-blocking gates |
|---|---|---|
| P0 | One approved correction commits end-to-end without App dependency | **Deterministic:** 0 unauthorized writes, 0 false/partial commits, 0 duplicate-replay commits; 100% identity preservation (OBO path); concurrency + stale-version tests pass. **Agent:** 100% refusal of unapproved write prompts; ≥95% correct tool routing. |
| P1 | Durable staging, commit, audit/outbox, Delta projection | Invariant/property tests pass; audit-target reconciliation exact; kill switches + limits block 100% of violating cases; credential/publisher-failure recovery passes; agent never bypasses preview/approval. |
| P2 | All four modalities produce provenance-linked canonical proposals | xlsx/csv golden corpus parses exactly; injection suite → 0 instruction/tool-policy changes; low-confidence image/text commits = 0; agent requests clarification/review correctly in ≥95% of ambiguous cases. |
| P3 | Chase runs interactively + on schedule without duplicate/prohibited sends | Duplicate-send rate 0 under overlapping triggers/retries; suppression/consent/quiet-hours violations 0; backlog fail-close test passes; agent escalation routing ≥95%, 100% refusal of prohibited recipients. |
| P4 | Second instance/type runs through registered extension points + production controls | No regression in prior gates; config isolation/authz suite passes; deterministic finance suite stays 100%; agent routing/refusal ≥95%; load test within approved lock-wait/latency/outbox-lag budgets. |

**Overarching:** any failed deterministic **money / identity / authorization /
injection / replay / stale-version / duplicate-send** assertion blocks
promotion regardless of aggregate agent score.
