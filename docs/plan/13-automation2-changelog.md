# 13 — Automation #2 change-log: the framework-thesis test (vendor bank-detail)

**Question under test:** is genie-automations a *framework* ("add a config = new
automation") or a receivables tool? We built a **materially different** second
automation type and recorded, honestly, every change it forced — classified as
**config** / **additive capability** / **one-time engine generalization**. This is
the deliverable both partners asked for; the code lives in
`spikes/spike-01-lakebase-commit/sql/{06_vendor_automation,02_commit_change}.sql`
and `harness/vendor_test.py`.

## What automation #2 is

**Vendor bank-detail change governance** (Group Treasury / AP master-data): supplier
bank-detail change requests → a governed, **effective-dated** `vendor_bank_detail`
master. Chosen because it flips four axes at once and flips the one that matters —
**it has no cross-record aggregate invariant at all** (reconciliation's whole shape
is the over-allocation ceiling). It's also where SoD is a *real fraud control* (bank-
detail change = the classic BEC vector), so it makes two-person approval a business
requirement, not demo hygiene.

| Dimension | Reconciliation #1 | Vendor bank-detail #2 |
|---|---|---|
| Records | aggregate line-items per remittance | independent per-record |
| Aggregate invariant | over-allocation ceiling (GA005) | **NONE — pure per-record** |
| Validation | arithmetic vs oracle | **algorithmic + referential** (IBAN MOD-97, BIC format, vendor exists, IBAN-not-already-assigned) |
| Schedule | periodic cutoff | event-driven / one-off |
| SoD | platform hygiene | **intrinsic fraud control** |
| Write pattern | line-item upsert | **effective-dated supersede-and-insert (SCD-2)** |

## Proven live (fevm-felix-demo, genie-automations Lakebase)

- **Allocation regression: 10/10 PASS** — the engine generalization did **not** break
  the proven money path (identity, forge-reject, sole-boundary, SoD, idempotency,
  GA005, GA004, concurrency + negative-control).
- **Vendor suite: 6/6 PASS** — valid commit (audit `actor=alice`, `change_type=
  vendor_bank_update`); **GA012** bad-IBAN checksum; **GA013** IBAN-collision (unique
  across vendors); **GA003** self-approve blocked (SoD holds for the new type);
  **GA004** stale expected_version. Proposer=alice, approver=bob — two distinct
  principals, real SoD.

## The honest classification — config vs capability vs engine

Against the acceptance test (Claude): **PASS** iff new code is confined to an
*additive capability library referenced from config*, with **zero** changes to the
commit-proc control flow, ingest router, config schema, and agent tool contract, and
**no `if change_type == …` branch in the engine.**

| Change for automation #2 | Classification | Verdict |
|---|---|---|
| Canonical field shape, header aliases, locale, destination, schedule | **Config** | ✅ pure config (as thesis claims) |
| IBAN MOD-97 validator (`iban_is_valid`) + BIC-format check | **Additive capability** (deterministic fn referenced by the type) | ✅ additive, engine untouched |
| `vendor_master` + effective-dated `vendor_bank_detail` tables | **Additive capability** (new destination + its integrity constraints) | ✅ additive |
| `_apply_vendor_bank_update` handler (no root; referential/uniqueness; SCD-2 write) | **Additive capability** (new dispatched handler) | ✅ additive |
| **`commit_change`: hardcoded `change_type='allocation_upsert'` → dispatcher** | **One-time ENGINE generalization** | ⚠️ **the one engine change** |
| Shared control flow (identity, replay, SoD, idempotency, audit, outbox, state) | **Unchanged** | ✅ type-agnostic |
| `genie_automations_config` schema / ingest router / agent tool contract | **Unchanged** | ✅ |

### Verdict: **conditional pass — exactly as predicted, and it's a *win*.**

The GA011 hardcode **was** the over-fit-to-receivables leak. Automation #2 forced the
choice both partners foresaw: add another `if change_type ==` branch (a growing leak)
or **refactor the dispatch to be registry/handler-driven once** (additive thereafter).
We did the latter. So:

- The framework claim is **true, with a precise boundary** — the capability-maturity
  model both partners converged on:
  - **L1 — new *instance* of an existing type** (e.g. a second receivables collection
    process): **pure config, zero code.**
  - **L2 — new *type*** (vendor bank-detail): **config + additive handler + additive
    validation functions**; the engine's shared control flow is untouched. After this
    one-time generalization, adding L2 types is a bounded, reviewable additive step.
  - **L3 — a new capability the engine can't express** (e.g. a genuinely new write
    pattern beyond upsert/SCD-2): engine code + security review.
- **Honest thesis wording (adopt this):** *"New instances of registered automation
  types are config-only. New types add registered schemas, validation functions, and
  a dispatched handler — the shared commit/identity/SoD/audit engine is unchanged.
  Capability code changes only when existing extension points are insufficient."*

## Capability gaps surfaced (record, don't paper over)

- **`stage_change` idempotency entity-key is receivables-shaped:** it extracts
  `p_diff ->> 'remittance_id'` for the entity component (NULL for a vendor diff, so
  the key falls back to the full-diff hash). Works for the spike, but a correct
  per-type key needs the **entity field to be config-driven** (part of the Task Spec),
  not hardcoded. → additive fix, config-schema-adjacent; log as L2 follow-up.
- **Dispatch is an `IF/ELSIF` in the proc, not a data-driven registry table.** Fine at
  two types; at N types, promote `change_type → {handler, roots, invariant}` to a
  trusted registry so adding a type doesn't re-touch `commit_change` at all. → L2
  hardening.

## The vendor automation "config" (Task Spec) — the L1/L2 config surface

```yaml
task_id: vendor-bank-eu
task_type: vendor_bank_update          # dispatched to _apply_vendor_bank_update
owner: treasury-masterdata             # automation-owner (D3)
schedule: event-driven                 # one-off / ad-hoc (not periodic)
destination_binding:                   # admin registry (dual-control, D3)
  table: genie_spike.vendor_bank_detail
  write_pattern: effective_dated_scd2
canonical_fields: [vendor_id, new_iban, new_bic, effective_date, expected_version?]
header_aliases:                        # user-editable
  new_iban:  [iban, "bank account (iban)", kontonummer_iban]
  new_bic:   [bic, swift, swift_bic]
validation_rules:                      # user adds/tightens; references named fns
  - {field: new_iban, fn: iban_is_valid, level: block}   # additive capability
  - {field: new_bic,  rule: bic_format,   level: block}
  - {referential: vendor_id_exists_active, level: block}  # GA014
  - {uniqueness: iban_not_assigned_elsewhere, level: block} # GA013
approval:
  segregation_of_duties: required      # approver != proposer (GA003)
  # L2 follow-up: entitlement-based SoD (approver holds treasury-approver role)
```

Everything above the `validation_rules` `fn:`/`rule:` references is **pure config**;
the referenced functions + the handler are the **additive capability**; the dispatcher
was the **one-time engine generalization**. That is the framework thesis, drawn
precisely — before a customer, not after.
