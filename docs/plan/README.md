# genie-automations — Hardened Plan

This folder is the finalized planning package produced by running the
`new-project.md` methodology (Phase 3 Harden + Phase 4 Optimize) over the
Sep-18 plan, plus a focused debate on the commit-concurrency primitive and two
independent red-team passes (27 consolidated findings, C-01…C-27).

## Locked decisions (inputs to everything here)

- **Agentic write** is the chosen direction: the supervisor is a human's
  "co-worker" that proposes financial writes; a human approves; the write is
  staged, validated, and committed through a single governed boundary.
- **Commit concurrency (see 01):** aggregate-root locking (Design B) is the
  concurrency primitive; per-row `expected_version` is a **mandatory,
  orthogonal** lost-update guard.
- **Topology (see 05):** capabilities are **not** buried in the App. Formless
  supervisor serving endpoint + pure UC functions + a Postgres stored
  procedure (the **sole** mutation boundary) + Genie (user Q&A) + scheduled
  Jobs (bulk/chase). The `genie-automations` App is **UI-only** (client/BFF).
- **Ingest (see 02):** all uploads land in a governed UC Volume first
  (untrusted sandbox, raw bytes + SHA-256). `xlsx` (hard requirement) and
  `csv` go through **deterministic** parsers (no LLM in the money path);
  images and freeform chat go through a **probabilistic** path that is
  **always** confidence-gated + human-confirmed. `ingest` is a modality router.
- **Config (see 02):** metadata schema `genie_automations_config`; user-editable
  settings are firewalled from admin-registry security bindings; published
  versions are immutable and hash-pinned.
- **Genie-native file upload** is **out** of the pipeline (demo/benchmark only).

## Contents

| Doc | Owner | Content |
|---|---|---|
| [01-mutation-contract.md](01-mutation-contract.md) | write-path | proposal state machine, `commit_change` proc, period-lock decision, consistency table, outbox→Delta, audit integrity, reconciler rule |
| [02-config-and-ingest-contract.md](02-config-and-ingest-contract.md) | write-path | `genie_automations_config` schema, user/admin split, caller authz, ingest router + xlsx edge-cases + injection boundary |
| [03-harden-security-resilience.md](03-harden-security-resilience.md) | methodology | Phase 3: 9-domain security table, resilience/containment, edge-case register |
| [04-optimize-coverage-phases-gates.md](04-optimize-coverage-phases-gates.md) | methodology | Phase 4: coverage map, P0 riskiest-first, version pinning, phase success criteria + hard eval gates |
| [05-topology.md](05-topology.md) | methodology | target architecture diagram-spec + identity/OBO flow |
| [06-spike-specs.md](06-spike-specs.md) | write-path | Spike 1 (Lakebase commit) + Spike 2 (ingest) specs |
| [07-seam-fixes-and-open-decisions.md](07-seam-fixes-and-open-decisions.md) | Debby | QC cross-review fixes (folded in) + the open decisions to ratify |

## Status / go-no-go

This **is** the finalized plan package (the five exit-artifact contracts the
red-team demanded now exist). Consistent verdict across all rounds:

> **Start building the two spikes now. Do NOT build generalized P1–P4 until
> their results land.** Spike 1 also resolves the one open design decision
> (period-lock scope) by measurement.

See [07](07-seam-fixes-and-open-decisions.md) for the handful of decisions to
ratify before Spike 1 *concludes*.
