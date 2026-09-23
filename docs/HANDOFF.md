# genie-automations — Handoff Note

**Last updated:** 2026-09-23
**Workspace:** `fevm-felix-demo` (AWS eu-central-1 / Frankfurt) — use `--profile fevm-felix-demo` for all CLI work. (Note: the shell default `DATABRICKS_CONFIG_PROFILE=gtm-ai-agent` is **not** the right one — always pass `--profile fevm-felix-demo` explicitly.)
**Working tree:** clean, everything below is committed. Latest commit `d0e57bb`.

---

## 1. What this project is

**genie-automations is a general framework** for governed, agentic data-collection/automation on Databricks. **Reconciliation (receivables) is the *first* automation type; DEUTZ is the *first* pilot** — neither is baked into the architecture. A human works with an AI "co-worker" that proposes typed changes; **deterministic Postgres stored procedures are the sole mutation boundary** and enforce every money/identity/safety guarantee regardless of what the LLM does.

Read these first, in order, in a fresh session:
- `docs/plan/README.md` — index + locked decisions
- `docs/plan/09-automation-model-and-glossary.md` — **read-first**: framework vs. pilot, the `automation-owner` role, `schedule`/`period`/roots as config
- `docs/plan/10-ratified-decisions.md` — the D1–D5 decisions already made
- `docs/plan/13-automation2-changelog.md` — the framework-thesis verdict (see §4 below)

---

## 2. The live, working system (test it right now)

### The real app (ADR-006 Option A: native AppKit / DuBois / TypeScript+React)
**URL:** https://genie-automations-7474658643170817.aws.databricksapps.com
**Source:** `app/genie-automations/` (AppKit — Node server + React client; deploy via `databricks apps deploy`)
**What it is:** the agentic co-worker over the **live guarded procs**, writing to the real ledger **as the signed-in human via OBO** (`session_user = the human`, proven end-to-end in Node). Genie-styled: chat-first light canvas, right-hand Proposals panel, Activity log, OBO identity badge, GA00x errors as first-class callouts. Showcases **both** automation types (reconciliation + vendor bank-detail) in one co-worker.

**⚠️ Billing:** the app bills ~0.5 DBU/hr (MEDIUM) *while running*. **Stop it when done:**
`databricks apps stop genie-automations --profile fevm-felix-demo`
Cost estimate: ~$40/mo at 8×5 with scheduled start/stop; ~$90/mo worst case 24/7 (Azure West Europe, illustrative). Trivial vs. FM/Lakebase/warehouse costs.

**Demo script (~5 min):** `list the remittances` → `correct allocation A-2 on RDEMO-1 to 1150` (stages as you) → click **Approve** on your own proposal → **GA003** (SoD blocks self-approve) → on `p-seed-recv-1` (staged by *ops.alice*) **Approve → Commit** → green, `actor_id = the human` → `change VEND-1003 IBAN to NL91ABNA0417164300, BIC ABNANL2AXXX, effective 2027-05-01` (vendor type) → try a bad IBAN / over-allocation → GA012 / GA005.

### Backend: Lakebase Postgres (the safety core)
- **Lakebase project:** `genie-automations` (PG 17, native login on, scale-to-zero). Branch `production`, endpoint `primary`.
- **Schema:** `genie_spike` — roots (`remittance` + `subsidiary_period` w/ generation counter), `allocation`, `proposed_changes` (state machine), `audit_event` (hash-chain ready), `outbox`, vendor tables (`vendor_master`, `vendor_bank_detail`), `iban_is_valid()`.
- **The engine:** `commit_change` is now a **type-agnostic dispatcher** over additive handlers (`_apply_allocation_upsert`, `_apply_vendor_bank_update`) — shared control flow (identity, SoD, idempotency, audit, outbox, state) lives once in the parent. Guarded staging/approval procs (`stage_change`/`approve_change`) bind proposer/approver to `session_user`; direct DML revoked from callers. SQL lives in `spikes/spike-01-lakebase-commit/sql/` (`01_schema`, `02_commit_change`, `02b_guarded_approval`, `03_grants`, `06_vendor_automation`).
- **UC schema** `felix_demo_catalog.genie-automations` holds the governed **Volume** `raw_uploads/` (untrusted upload sandbox) — the Delta/audit-projection home for later.

### Error codes (guardrails) you'll see fire
`GA003` self-approve/SoD · `GA004` stale version · `GA005` over-allocation · `GA010` forged identity · `GA011` unknown change_type · `GA012` bad IBAN · `GA013` IBAN collision · `42501` direct-DML denied (sole-mutation-boundary).

---

## 3. Ratified decisions (docs/plan/10)

- **D1 — Period-lock = Design B** (per-subsidiary root → realistic fan-in 1–5 where B≈A′; A′ documented as scaling escape hatch). Commit-SLO to ratify at pilot ~300–500 ms p99.
- **D2 — Image path = vision-FM-in-endpoint** (`ai_query` multimodal); egress cleared (model in the Databricks contract). Always confidence-gated + human-confirmed.
- **D3 — automation-owner authority = dual-control** on the 3 security-sensitive bindings (destination table / write identity / chase-recipient registry); free self-service on everything else.
- **D4 — Red-team follow-up order = (i) → (ii) → (iii).** (i) guarded approval = **DONE**. (iii) silent-money parser bugs = **DONE** in parser v2. (ii) hostile-file-parse-in-a-bounded-Job = needed before *untrusted* uploads.
- **D5 — ADR-006 = Option A** (AppKit-Node native app; thin backend ported to Node; guarded procs unchanged). OBO re-proof in Node = **DONE** (`L0_full_obo` confirmed).

---

## 4. Proven / de-risked (the scary parts are behind us)

This is a **validated P0 vertical slice, not the finished product** (both partners agree). Retired risks:
- ✅ **OBO → Lakebase `session_user` = the real human**, proven in **both** Python (spike-03) and the **AppKit Node** app. Audit attribution is genuinely correct.
- ✅ **Deterministic safety core** — SoD (GA003), sole-mutation-boundary (42501), over-allocation (GA005), stale-version (GA004), idempotent replay, aggregate-root locking with a **negative control** (no-lock build leaks → test discriminates).
- ✅ **Period-lock curve measured live** (`spikes/spike-01-lakebase-commit/.../SWEEP_RESULTS.md`): B≈A′ at N≤5; A′ wins at N=20/50; seal-race detector validated (A-naive leaks, B/A′ = 0 misses).
- ✅ **Deterministic ingest** (xlsx/csv) — parser hardened per partner code-read: per-config locale (no silent 1000×), formula-reject, injective binding, totals-row skip, hostile-file rejection. Corpus 8/8 @ 100%, hostile 9/9, units 4/4. Live Volume round-trip green.
- ✅ **Probabilistic image path** — live vision-FM bake-off: 100% clean-corpus accuracy, injection resisted + caught by cross-foot; always-human-confirm gate.
- ✅ **Framework thesis demonstrated, not asserted** (automation #2 = vendor bank-detail): generalized the engine from a hardcoded `change_type` to a dispatcher; allocation regression stayed 10/10, vendor suite 6/6. **Verdict = conditional pass** → maturity model: **L1** new instance = pure config; **L2** new type = config + additive handler/validators (engine untouched); **L3** genuinely new capability = code + review.

---

## 5. Open items / what's NOT done yet

**Highest-leverage next (both partners' #1):**
- ⏭️ **Two-*human* SoD** — currently you approve a proposal seeded by a different principal (`ops.alice`) — proposer ≠ approver is real, but the second identity is a **seed, not a live colleague**. Deferred by Felix's choice until a colleague is available. When ready: provision (a) a 2nd **service principal** as a Lakebase Postgres login role for a repeatable no-human-dependency control proof, and/or (b) a **real colleague** approving in the browser via forwarded-token OBO (the true two-human proof — needs a human to click).

**App polish / breadth:**
- ⏭️ **File upload + image paths not yet wired into the AppKit UI** (both proven separately in spikes — `volume_e2e.py`, the image bake-off).
- ⏭️ **DuBois styling is first-pass** (semantic tokens + AppKit components, not final-tuned) — see `docs/plan/11-ui-ux-spec.md` / `12-design-tokens.md`. Pull exact token values from live AppKit-ui at build time.
- ⏭️ **`ask_data` / Genie** as a read tool not yet wired.

**Framework / production hardening:**
- ⏭️ **Chase** (outbound + inbound reply-handling) — half the value prop — not built. Designed as an independent Job on SP identity.
- ⏭️ **Config-governance surface** (the `genie_automations_config` admin/user split + dual-control workflow, D3) — no UI yet.
- ⏭️ **MLflow eval gate** — the red-team (27-finding register, `docs/plan/03`) was run by hand; needs deterministic + agent eval as release-blocking gates (`docs/plan/04`).
- ⏭️ **(ii) hostile-file parse in a resource-bounded Job** — before opening uploads to untrusted parties.
- ⏭️ **Two known receivables-shaped gaps** (recorded in `docs/plan/13`): `stage_change` computes its idempotency entity-key from `remittance_id`; the `IF/ELSIF` change_type dispatch should become a registry table at N types.
- ⏭️ **Data lifecycle:** ledger has ~56 accumulated remittances from earlier spikes (noise) — steer demos to RDEMO-1/2/3 and VEND-* .

---

## 6. Repo map

- `docs/plan/01–13` — the hardened plan package (mutation contract, config/ingest, harden/red-team, optimize/gates, topology, spike specs, seam-fixes, period-lock decision, automation model+glossary, ratified decisions, UI/UX spec, design tokens, automation-2 changelog).
- `PLAN.md` — original plan + ADRs (ADR-001…006).
- `app/genie-automations/` — **the real app** (AppKit Option A).
- `spikes/spike-01-lakebase-commit/` — the safety core (schema, procs, harness, sweep).
- `spikes/spike-02-ingest/` — deterministic parser + corpus/hostile harness + image bake-off + `volume_e2e.py`.
- `spikes/spike-03-supervisor-endpoint/` — `SPEC.md`, `PIVOT.md` (why App not endpoint), the Python identity app + in-app agent (superseded by the AppKit app but useful reference).
- `spikes/walkthrough/` — narrated runnable ingest→write console (real parser + guarded procs).

## 7. How to resume work (CLI cheatsheet)

```bash
# Auth (OAuth tokens last ~1h; re-auth is interactive/browser)
databricks auth login --profile fevm-felix-demo

# App: status / logs / stop / redeploy
databricks apps get genie-automations --profile fevm-felix-demo
cd app/genie-automations && databricks apps deploy genie-automations --profile fevm-felix-demo

# Lakebase creds for running the harnesses (see each spike README for the exact flow)
#   mint owner token -> set alice/bob passwords -> run harness
```

**Debby note:** this project has been driven with two AI partners (Claude + GPT) fanned out on every substantive design fork, with a `/debate` skill for stress-testing. Continue that pattern for design decisions; drive pure execution/build/doc work directly.

---

## 8. Suggested next move

Both partners' converged recommendation: the remaining work is **known-shaped breadth, not unknown-shaped risk**. Highest-leverage sequence:
1. **Two-human SoD** (once a colleague / 2nd SP is available) — closes the last simulated gap.
2. **Wire file-upload + image into the AppKit UI** — completes the co-worker's input modalities in the real app.
3. **Chase** + **config-governance UI** + **MLflow eval gate** — the productionization arc toward a DEUTZ pilot.
