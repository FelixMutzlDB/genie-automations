# 10 — Ratified decisions (2026-09-22)

Felix ratified the four open items after the Claude↔GPT decision briefing (both
partners converged on all four). Recorded here so they don't reopen.

## D1 — Period-lock: **B (lock-both)** ✅
Lock the remittance AND the `(subsidiary, period)` header (`FOR UPDATE`, require
`status='open'`, bump generation under it). Rationale: at the realistic
single-root fan-in for per-subsidiary reconciliation (~1–5) B ≈ A′ on the
measured curve, and B is safe-by-construction with no seal-boundary proof to
maintain. A′ (share-lock) is retained **documented as the scaling escape hatch**
— revisit only if a *shared group-level* period root produces sustained fan-in
≥20 that breaches the commit p99 SLO. The production `commit_change` already
implements B. Commit-latency SLO to ratify at pilot: **commit p99 ≈ 300–500 ms**,
derived as a small slice (~10–20%) of a ~2–3 s click-to-confirm agent turn.
(See 08 + SWEEP_RESULTS.)

## D2 — Image path: **lead with vision-FM-in-endpoint** ✅
Interactive screenshot paste → `ai_query` multimodal (vision FM) in the serving
endpoint; `ai_parse_document`+`ai_extract` Job reserved for bulk/multi-page.
**Data-egress: cleared** — the multimodal model is part of the Databricks
contract, so sending financial screenshots to it is acceptable. Always
Volume-land the raw image first; output always flows through the
confidence-gate + human-confirm (never auto-commit). Next: run the 15–30 image
bake-off (accuracy/latency/cost) to set the per-modality bar.

## D3 — Automation-owner authority: **B (dual-control on the 3 sensitive bindings)** ✅
The automation-owner freely edits non-security config (validations, aliases,
tone, schedule, thresholds) but **destination catalog/schema/table, write/execution
identity, and the external chase-recipient registry** are *proposed* by the owner
and *ratified* by a platform/security admin (dual-control, C-08/C-09). Holds for
both pilot and the self-service future (risk rises with scale → dual-control
matters more, tooling changes: manual → policy-as-code). Escape hatch for future
self-service: if the platform pre-constrains destinations (allowlist) + fixes
execution identity per automation-type, owners may go unilateral on the residual.

## D4 — Red-team follow-up order: **(i) → (ii) → (iii)** ✅ (as Felix ordered)
- **(i) Guarded staging/approval procs — hard blocker, doing now.** `stage_change`
  / `approve_change` procs (approver ≠ proposer, records approver, sole path to
  `approved`); **revoke direct UPDATE on `proposed_changes.state`** from callers.
- **(ii) Zip-bomb/XML-entity parse in a resource-bounded Job** — before widening
  uploads to untrusted parties.
- **(iii) Merged-cell-header acceptance + corpus** — NOTE: the silent-money-
  corruption bugs originally under (iii) (locale, totals-row, header-offset,
  formula→None, cross-canonical double-bind) are **already closed** in parser v2
  and proven green. What remains is merged-header *acceptance* (today fails safe:
  rejects rather than misparses), which is a fast-follow feature, not a
  silent-corruption risk.

> Cross-cutting (Claude): D1's "B is safe enough" relies on the human-approval
> gate (i) + a correct parser (iii-silent-bugs, already closed). Do not ship a
> real-user pilot before (i) closes — the spike's caller-can-self-approve
> shortcut makes the current green run look safer than a real pilot would be.
