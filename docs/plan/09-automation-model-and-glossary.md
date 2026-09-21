# 09 — Automation model & glossary (read this first)

**genie-automations is a GENERAL framework, not a reconciliation product.**
Receivables **reconciliation / data-collection is the *first automation type*,
and DEUTZ is the *first pilot*.** Neither may leak into the plan as a built-in
assumption. This doc is authoritative on terminology and generalizes the
concrete examples used elsewhere (01, 02, 08).

## What the framework is

A framework for **config-defined automations**, each following the same shape:

    ingest → validate → propose change → (human approve) → governed write → notify

Adding a new automation is (for a registered task family) a **config** action,
not code. The reusable machinery — supervisor endpoint, ingest router, pure UC
functions, the `commit_change` stored procedure (sole mutation boundary), Genie
Q&A, Jobs — is automation-agnostic. What varies per automation is **config**.

## Glossary

- **automation** — a configured unit of work the framework runs end-to-end. An
  instance of an *automation type*, owned by an *automation-owner*, described by
  a versioned entry in `genie_automations_config`.
- **automation type** (`task_type`) — the reusable shape of an automation.
  **Receivables reconciliation is the first type**; others are added later.
  Some types share machinery as config only; genuinely new capabilities are code
  (see the capability maturity model — 02/04).
- **automation-owner** — *(new role)* the person who **owns an automation and
  defines its config**: task registration, target schema, validation
  requirements, header aliases, thresholds, schedule/cadence, chase settings.
  **Authority scope (working assumption — confirm):** full authority over
  *non-security* config; **security-sensitive bindings** (destination
  catalog/schema/table, write/execution identity, external chase-recipient
  registry) are *proposed* by the automation-owner but require **dual-control
  ratification** by a platform/security admin (C-08/C-09). This preserves the
  confused-deputy firewall — an owner cannot unilaterally repoint where money is
  written or who gets messaged.
- **end-user / submitter** — supplies inputs (upload/text/image) to an
  automation; never trusted as an instruction source.
- **approver** — a human who approves a proposed change; for material changes
  must differ from the proposer (segregation of duties, GA003).
- **platform/security admin** — ratifies security-sensitive config bindings;
  owns the destination allowlist and recipient registry.
- **schedule** — *triggering* config, orthogonal to the data model. **Absent =
  one-off** (manual/event trigger, runs once); **present = recurring** (cron).
  The framework supports **both**. A one-off automation still defines its own
  roots/invariants; it simply isn't re-run.
- **period** — a **config-defined grouping/cadence** used *only by automation
  types that need one*. For recurring reconciliation the "period" (e.g. a
  quarter) aligns with the schedule. It is **not** a universal concept: one-off
  or non-grouped automations may have **no period at all**.
- **aggregate root / invariant** — **per automation type.** Trusted capability
  code maps `change_type → {roots, invariant_policy}` (01 §2). Reconciliation's
  roots (`remittance`, and a `(subsidiary, period)` reconciliation header) are
  **one instance**. Automation types with **no cross-record aggregate
  invariant** (pure per-record writes) have **no roots to lock** — and the
  period-lock question (08) **does not arise** for them.

## De-pilot-ification (things that are NOT plan assumptions)

- **"60 entities / subsidiaries"** is DEUTZ-pilot scale, **not** a plan constant.
  Entity count, fan-in, and peak arrival rate are **pilot/deployment inputs**
  supplied per automation, discovered at pilot time — never hard-coded.
- The plan targets the **general** case; the reconciliation spikes (Spike 1/2)
  are the **concrete first instance** used to de-risk the shared machinery.

## Amendments to existing docs (so they aren't read too literally)

- **01 (mutation contract):** the aggregate roots + invariants shown
  (`remittance`, `(subsidiary, period)`, over-allocation, reconciled-position)
  are the **reconciliation automation type's** roots — one instance of the
  general `change_type → {roots, invariant_policy}` mapping. Other types declare
  their own; some declare none.
- **02 (config/ingest):** `task_registry.owner` **is** the *automation-owner*.
  `schedule` covers **one-off (absent) and recurring (cron)**. "period"/"cadence"
  are config owned by the automation-owner. The user-editable vs
  admin-security-binding split is exactly the automation-owner authority scope
  above.
- **08 (period-lock sweep):** the period-lock fork is a property of the
  **reconciliation automation type specifically** (it has a `(subsidiary,
  period)` aggregate invariant). **Fan-in N is a config-driven / pilot-scale
  input, not DEUTZ's 60** — run the sweep across N and decide **per automation
  config** when that automation's realistic peak is known. Automation types
  **without** a period/aggregate invariant do not need this decision at all.

## Open confirmations (proceeding on the working assumptions above)

1. automation-owner authority vs dual-control for security-sensitive bindings (as above).
2. roots/invariants declared per automation type, incl. types with none.
3. schedule = triggering config only (one-off vs recurring), orthogonal to the data model.
