# genie-automations

A framework for **data-related office automations that extend Genie beyond "talk to your
data."** Genie answers questions about governed data; genie-automations lets an agent also
*take in*, *validate*, *change*, and *chase people for* that data — the recurring
"collect-and-reconcile-from-many-parties" work that today lives in spreadsheets and email.

One **supervisor agent** (a gateway-registered serving endpoint) orchestrates a set of
reusable **capabilities**. Each concrete automation is driven by a declarative **Task Spec**
(a "theme" / "topic") that defines the expected data shape and target, the accepted input
types, the required validations, and the people/entities to chase. A task type can be
implemented many times — collecting receivables has a different target, validations, and
chase list than gathering headcount.

> **Status:** planning. Build kicks off the week of 2026-09-22. See [`PLAN.md`](PLAN.md).

## The shape

```
App UI  ──▶  Supervisor agent (Model Serving endpoint, AI Gateway registered)
                     │  orchestrates capabilities as tools
                     ▼
   ┌───────────┬──────────┬───────────┬──────────┬──────────┐
   │ ask_data  │  ingest  │  validate │  modify  │  chase   │   ← capabilities
   │ (Genie)   │ (files/  │ (checks,  │ (govern- │ (collect/│
   │           │  text/   │  deter-   │  ed      │  dispute/│
   │           │  images) │  ministic)│  write)  │  correct)│
   └───────────┴──────────┴───────────┴──────────┴──────────┘
                     │  driven by
                     ▼
              Task Spec  (receivables, headcount, …)  ← one per automation instance
```

Interactive records land **through Lakebase (OLTP) into Delta/UC (governed, analytical)**
via synced tables. Bulk file drops keep the medallion path. Deterministic SQL owns every
number; the LLM only phrases, prioritises, and converses.

## Layout

```
PLAN.md                 the plan: layers, decisions, phases, kickoff
docs/                   architecture + the Task Spec contract
packages/core/          the framework: taskspec, capabilities, supervisor, storage
tasks/                  one folder per automation (receivables is task #1)
app/                    Databricks App: UI + MCP server exposing capabilities
bundle/                 Databricks Asset Bundle: app, endpoint, lakebase, jobs, genie, dashboard
oracle/                 dependency-free behavioural golden for the validate capability
```

## Provenance

Generalises the receivables-collection prototype in the sibling
`group-reconciliation-automation` project (pipeline-first proof) into an agent-first,
capabilities-as-tools framework. The prototype's config triple, reconciliation checks, and
local oracle are ported in; only the framing is new.

## Guardrails

- Deploy with an explicit `--profile <PROFILE>`; never auto-select one.
- Secrets (channel webhooks, FX creds) via Databricks Secrets, never inline.
- **This is a public repo:** synthetic entity names only, no real customer names or data in
  any committed artifact. Real engagement context lives in internal notes only.
