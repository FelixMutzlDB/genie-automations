# genie-automations — project plan

> A framework for **data-related office automations that extend Genie beyond "talk to your
> data."** A supervisor agent (a gateway-registered serving endpoint) orchestrates reusable
> capabilities; each concrete automation is a declarative **Task Spec**. Build kicks off the
> week of 2026-09-22.

- **Form factor (now):** a Databricks App that hosts the capability services and UI, calling
  a **supervisor serving endpoint** registered in the AI Gateway.
- **Form factor (target):** a *formless* serving endpoint that any surface (app, URL, another
  agent) can call. We build the app-plus-endpoint shape now precisely so the endpoint is the
  durable interface, not the app.
- **Provenance:** generalises the pipeline-first receivables prototype in the sibling
  `group-reconciliation-automation` project. ~70% of the thinking is reused (the config
  triple, the reconciliation checks, the local oracle); the framing is new.

---

## 1. Why this exists

Genie removed the analyst queue for *questions about data*. It does nothing for the recurring
office work that surrounds the data: taking submissions in (Excel, CSV, text, images), checking
them the way a controller does by hand, correcting them, and chasing the people who owe them.
That work still lives in spreadsheets and email — ungoverned, invisible, slow.

genie-automations makes that work a first-class, governed, agent-driven capability on
Databricks. The wedge is the same shadow-IT play: land one painful collect-and-reconcile
process on governed Databricks, prove the win, then repeat **by config** across the many such
processes a large organisation runs (receivables, intercompany, headcount, ESG, cash pooling…).

**Reference automation (task #1):** group receivables collection and reconciliation across
~60 subsidiaries — pull imperfect template submissions, reconcile them deterministically,
and chase the laggards on time and in quality until a clean consolidated position is ready.

## 2. The core abstraction

A **Task Spec** is the "theme / topic / task" — the single config unit that makes automations
repeatable. It declares:

- **Data contract** — the expected shape and the target table/schema the data lands in.
- **Accepted inputs** — which input types this task handles (excel, csv, txt, images, chat text).
- **Validations** — the deterministic checks entries must pass (the old `checks_config.yml`).
- **Chase targets** — who/which entities owe data, on which channel, with what escalation.
- **Routing / schedule / tone** — cut-off calendar, cadence, escalation policy, message tone.

A task **type** (e.g. receivables) is implemented many **instances** (customer-specific), each
with its own target, validations, and chase list. Task type = template; instance = spec file.
This is the "add an automation = add a Task Spec" seam.

> The prototype already had this as three separate files (`process.yml`, `checks_config.yml`,
> `subsidiary_registry`). The generalisation is to name it, schema it, and make **every
> capability read from it**. See [`docs/task-spec.md`](docs/task-spec.md).

## 3. Architecture (four layers)

Full detail in [`docs/architecture.md`](docs/architecture.md). Summary:

**Layer 1 — Task Spec.** Declarative config per automation instance (§2).

**Layer 2 — Capabilities.** Each is reusable, Task-Spec-driven, and **independently
addressable as a tool** (so the supervisor endpoint can reach it without the app):

| # | Capability | Does | Built from | Form |
|---|-----------|------|-----------|------|
| 1 | `ask_data` | normal Genie "talk to your data" over the governed target | Genie Conversation API | tool wrapper |
| 2 | `ingest` | take input (excel/csv/txt/image/chat) → canonical rows | `ai_parse_document` / `ai_extract` + normaliser | serving / MCP tool |
| 3 | `validate` | run the task's declared checks (chat- or file-sourced) | the checks engine | **UC function** (deterministic) |
| 4 | `modify` | governed write / correct / upsert of a record | *new* | **UC function** (idempotent, audited) |
| 5 | `chase` | collect / dispute / correction nudges + escalation | multi-channel notifier + registry | serving tool + scheduled job |

**Layer 3 — Supervisor.** A Mosaic AI `ResponsesAgent` on a Model Serving endpoint,
**registered in the AI Gateway**, orchestrating capabilities 1–5 as tools. MLflow-traced.
(Agent Bricks MAS is deferred — see ADR-004.)

**Layer 4 — App.** A Databricks App = UI + a **custom MCP server exposing the capabilities**.
The app UI calls the supervisor endpoint; the supervisor reaches the capabilities via the MCP
server / UC functions. This satisfies "the app hosts the services" while keeping the tools
reachable by the endpoint alone (the formless-endpoint future).

## 4. Storage: through Lakebase into storage

Split by **access shape**, not preference (ADR-002):

- **OLTP write / interaction surface → Lakebase (Postgres).** Chat-entered data, corrections,
  `modify` upserts, per-session and agent state, task-run state, the chase log. Low-latency,
  transactional, single-row writes — what an interactive app + agent do constantly. Reuse the
  Innovation Factory Lakebase Autoscaling + hourly-OAuth `do_connect` refresh pattern.
- **Analytical / governed read surface → Delta / UC, fed by Lakebase synced tables.**
  Consolidation, Genie "talk to your data", dashboards, cross-period reconciliation, the
  immutable audit copy. Genie and dashboards read UC, so the synced copy is mandatory.
- **Bulk file ingest stays medallion.** A subsidiary dropping a 500-row Excel goes
  Volume → bronze (raw bytes retained) → canonical, so a rule change replays from stored
  files and never re-asks the sender.

Net: **Lakebase is the system-of-entry** for interactive records; **Delta/UC is the
system-of-record** for analytics and audit; **synced tables bridge them.** Every financial
write is append-only and durable on the Delta side so the "did the agent really change that
number?" audit story holds.

## 5. Repository layout

```
PLAN.md                       this file
docs/
  architecture.md             the four layers, rendered flow, component choices
  task-spec.md                the Task Spec schema contract
packages/core/
  taskspec/                   Task Spec schema + loader/validator
  capabilities/
    ask_data/  ingest/  validate/  modify/  chase/
  supervisor/                 ResponsesAgent tying capabilities as tools
  storage/                    lakebase (OLTP) + synced-tables-to-UC helpers
tasks/
  receivables/                task #1 — ported from the prototype (spec, checks, schema, registry)
app/                          Databricks App: UI + MCP server exposing capabilities
bundle/                       DAB: app, serving endpoint, lakebase, jobs, genie space, dashboard
oracle/                       demo_local.py — dependency-free behavioural golden for validate
```

## 6. Phased delivery (build the shape early)

Each phase is independently demoable; **P0 alone proves the endpoint-first thesis.**

| Phase | Scope | Demoable milestone |
|---|---|---|
| **P0 — Shape** | Task Spec schema; port receivables → `tasks/receivables`; minimal supervisor `ResponsesAgent` on a gateway endpoint calling **one** tool (`ask_data`) from a bare app UI | App → gateway endpoint → Genie tool answers a question end to end |
| **P1 — Deterministic tools + storage spine** | `validate` (diff-matched to the oracle) and `modify` as UC functions writing to Lakebase; stand up Lakebase→UC sync | The agent validates an entry and writes a governed correction |
| **P2 — Input** | `ingest` for excel/csv/txt/image via `ai_parse_document`/`ai_extract`; chat-upload and Volume-drop; canonicalise to the Task Spec | Dropping a messy file (or pasting rows in chat) yields validated canonical rows |
| **P3 — Chase** | multi-channel outbound + escalation; chase log in Lakebase synced to Delta; supervisor runs it interactively and on schedule | The agent chases a laggard, re-checks on re-upload, escalates, thanks |
| **P4 — Second task by config** | stand up a second task (e.g. headcount) with zero new capability code; harden (MLflow eval, ABAC/OBO, dashboard + Genie space) | A second automation runs with only a new Task Spec |

## 7. Key decisions (ADRs)

- **ADR-001 — New package, receivables migrated in (not an edit of the prototype, not a
  rebuild).** The prototype is pipeline-first and single-process; the abstraction inverts the
  topology (supervisor is the system, pipeline is one capability). Re-home + re-shape, keeping
  the config triple, checks, and oracle intact.
- **ADR-002 — Through Lakebase into storage** (§4). Driven by the shift from batch-only to
  interactive writes.
- **ADR-003 — Capabilities are independently addressable tools** (UC functions for
  `validate`/`modify`; MCP / serving for the rest), not logic buried in the app process —
  otherwise the endpoint is hostage to the app and never becomes formless.
- **ADR-004 — Single `ResponsesAgent` with tool-calling now; Agent Bricks MAS deferred.**
  More control and observability up front; revisit MAS only if capabilities become genuinely
  independent specialist agents.
- **ADR-005 — Determinism where money is involved.** Every number comes from deterministic
  SQL / UC functions; the LLM only phrases, prioritises, and converses. Non-negotiable for
  finance auditability.

## 8. Open questions for kickoff

1. Target workspace + catalog/schema for the framework and task #1 (a writable demo catalog).
2. Foundation-model endpoint for the supervisor + AI functions (Claude via Gateway is default).
3. Lakebase project: reuse the Innovation Factory instance or a dedicated one for this package.
4. First live chase channel (Teams webhook) vs dry-run-only for the first demo.
5. MCP-on-app vs UC-functions-only for the first capability wiring in P0/P1.

## 9. Build-time skills to load (next week)

When implementation starts, route through the Databricks skills: `databricks-core` first, then
`databricks-apps` (app + MCP server), `databricks-model-serving` (supervisor endpoint),
`databricks-lakebase` (OLTP + synced tables), `databricks-agent-bricks` (if MAS is revisited),
`databricks-genie` (the `ask_data` capability), and `databricks-dabs` (the bundle).

---

*Companion: the pipeline-first proof and behavioural oracle live in the sibling
`group-reconciliation-automation` project.*
