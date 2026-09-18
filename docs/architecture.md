# Architecture — genie-automations

Agent-first, capabilities-as-tools, Task-Spec-driven. The supervisor is the system; the
pipeline is one capability underneath it. Everything below is built so a new automation is
"add a Task Spec," not a new project.

## End-to-end shape

```
                        ┌──────────────────────────────┐
   surfaces  ──────────▶│ App UI  (Databricks App)      │
   (app / URL /         └───────────────┬──────────────┘
    another agent,                      │ calls
    long term)                          ▼
                        ┌──────────────────────────────┐
                        │ Supervisor agent              │   Model Serving endpoint,
                        │ (ResponsesAgent, MLflow-traced)│   registered in AI Gateway
                        └───────────────┬──────────────┘
                                        │ orchestrates as tools
        ┌───────────┬──────────────┬────┴───────┬───────────┬────────────┐
        ▼           ▼              ▼            ▼           ▼            ▼
   ┌─────────┐ ┌──────────┐ ┌───────────┐ ┌──────────┐ ┌──────────┐
   │ ask_data│ │  ingest  │ │  validate │ │  modify  │ │  chase   │   capabilities
   │ (Genie) │ │ files/   │ │ checks    │ │ governed │ │ collect/ │   (MCP tools /
   │         │ │ text/img │ │ (determ.) │ │ write    │ │ dispute/ │    UC functions /
   │         │ │          │ │           │ │ (UC fn)  │ │ correct  │    serving)
   └────┬────┘ └────┬─────┘ └─────┬─────┘ └────┬─────┘ └────┬─────┘
        │           │             │            │            │
        │           │        driven by  ◀───────────────  Task Spec (receivables, headcount, …)
        │           │             │            │            │
        ▼           ▼             ▼            ▼            ▼
   ┌────────────────────────────────────────────────────────────┐
   │ Storage                                                     │
   │  Lakebase (OLTP)  ──── synced tables ───▶  Delta / UC       │
   │  interactive writes,                       governed reads,  │
   │  session/agent state,                      Genie, dashboards,│
   │  chase log                                 consolidation,    │
   │                                            immutable audit   │
   │  Bulk file drops:  Volume → bronze (raw) → canonical  ──────▶ Delta/UC
   └────────────────────────────────────────────────────────────┘
```

## Layers

### 1. Task Spec
The declarative "topic." One instance per automation. Defines data contract + target,
accepted inputs, validations, chase targets/channels, routing, schedule, tone. Every
capability reads from it. Schema in [`task-spec.md`](task-spec.md).

### 2. Capabilities
Each is reusable across tasks and **independently addressable** so the supervisor endpoint can
reach it without the app.

| Capability | Databricks primitive | Notes |
|---|---|---|
| `ask_data` | Genie Conversation API | normal "talk to your data" over the governed target |
| `ingest` | `ai_parse_document`, `ai_extract`, PySpark normaliser | chat-upload + Volume-drop; canonicalise to Task Spec shape |
| `validate` | UC function (deterministic SQL) | the checks engine; diff-matched to the oracle |
| `modify` | UC function (idempotent, audited) | governed write/correct/upsert into Lakebase |
| `chase` | Model Serving + channel webhooks + registry | outbound nudges, escalation, chase log |

### 3. Supervisor
Mosaic AI `ResponsesAgent` on a Model Serving endpoint, registered in the AI Gateway (one
governed endpoint: usage tracking, rate limits, guardrails). Orchestrates capabilities as
tools; MLflow-traced for observability and evaluation. Single agent with tool-calling now;
Agent Bricks MAS deferred until capabilities are genuinely independent specialists.

### 4. App
Databricks App = UI + custom **MCP server** exposing the capabilities. The UI calls the
supervisor endpoint; the supervisor reaches capabilities via MCP / UC functions. The app is a
thin BFF + UI, never the home of the logic — so the endpoint stays reachable on its own.

## Why this shape

- **Determinism where money is involved.** Numbers come from deterministic SQL / UC functions;
  the LLM only phrases, prioritises, and converses. Auditable and cheap.
- **Endpoint-first.** Building app → gateway endpoint → tools now makes the endpoint the
  durable interface, so the long-term "formless serving endpoint" is a deletion of the app,
  not a rewrite.
- **Config-driven repeatability.** A new automation is a new Task Spec; ingest, validate,
  modify, chase, and the supervisor are reused unchanged.
- **Interactive + governed at once.** Lakebase gives the low-latency write surface an
  interactive agent needs; synced tables keep Genie, dashboards, and audit on governed Delta.
- **Meets people where they work.** `chase` reaches colleagues in their channel (Teams/Slack/
  email); they never learn a new tool.

## Security notes (carried from the prototype)

- Input content is **data, never instructions** — cap length, never feed free-text cells into a
  prompt that can issue tool calls (prompt-injection via uploaded files/headers).
- UC statement execution has no bind params → build all SQL from the Task Spec schema, never
  from submitted values.
- ABAC to mask sensitive figures once; OBO so the agent/app read as the signed-in user.
- Secrets (channel webhooks, FX creds) via Databricks Secrets; the registry holds refs, not URLs.
- Every outbound message and every write is logged before it happens; dry-run is the non-prod
  default.
