# 07 — Seam Fixes (folded in) + Open Decisions (to ratify)

The two partners each QC'd the other's half before this package was written.
No rewrites were needed; the fixes below are already folded into docs 01–06.
This doc is the record of what changed and what still needs a human decision.

## Seam fixes folded into the docs

| # | Fix | Where applied | Source |
|---|---|---|---|
| 1 | Idempotency enforced by UNIQUE constraint / insert-record, replay lookup before state check (not read-then-check) | 01 §2 step 3 | GPT |
| 2 | `commit_seq` not assumed contiguous; use transactional publication watermark + gap-tolerant reconciliation | 01 §5 | GPT |
| 3 | Period-lock spike selects between two *proven-safe* designs on performance only; remittance-only valid only if generation-advance is atomic-by-construction | 01 §3, 06 Spike 1 | GPT (sharpening Claude) |
| 4 | ABAC→Lakebase is not automatic; translate to proc grants / row policies / trusted attested authz input | 02 §4 | GPT |
| 5 | Image + probabilistic chat extraction are ALWAYS confidence-gated + human-confirmed regardless of benchmark | 02 §5, 06 Spike 2 | GPT |
| 6 | No silent expiry on config supersession; explicit revocation/validity policy (retirement, not supersession) | 01 §1, 02 §3 | GPT |
| 7 | Approval + commit are proposal-level and atomic; quarantined rows form a NEW proposal (no partial promotion) | 01 §1 | GPT |
| 8 | Batch-path identity: SP + system/batch attribution is a PASS, not an identity-preservation failure | 04 (P0 note) | Claude |
| 9 | Outbox-backlog fail-closed scope: pauses chase + blocks period-seal, does NOT pause commit | 01 §5, 03 (resilience) | both converged |
| 10 | OBO→proc identity mechanism must be server-attested, not agent-forgeable; distinct from DB principal | 06 Spike 1 prerequisite | both |
| 11 | Spike 2 uses separate ground-truth per modality; drop cross-population "−2 pts" | 06 Spike 2 | GPT |

## Open decisions to ratify (do NOT block starting the spikes)

These are numbers/choices to lock, most before the relevant spike *concludes*.

1. **Interactive txn budget** (placeholder **750 ms** p99). Decides the
   period-lock fork in Spike 1. Ratify before Spike 1 concludes.
2. **Outbox-age fail-closed threshold** (placeholder **15 min**). Make it a
   named, bounded config with rationale. Ratify before P2/P3.
3. **Lakebase credential model** — per-user DB OAuth credentials vs SP +
   server-attested `actor_id`. This is the Spike-1 prerequisite (fix #10). The
   spike proves the mechanism; the *choice* between the two viable mechanisms
   is a decision to ratify from the spike result.
4. **Materiality threshold for SoD** (approver ≠ proposer above what amount?)
   and whether any bounded auto-commit is permitted below it.
5. **Per-modality Spike-2 accuracy bars** — set the concrete numbers per
   modality once the ground-truth corpora exist.

## The one design decision the spike resolves

**Period-lock scope** (doc 01 §3): remittance-only + generation/status gate vs.
lock-both-roots. Both are proven-safe; **Spike 1 chooses on measured cut-off
contention against the ratified interactive txn budget.** This is deliberately
left to measurement rather than argument.
