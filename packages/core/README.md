# packages/core — the framework

Reusable, task-agnostic machinery. Nothing here is customer- or task-specific; all task
specifics live in `tasks/` as Task Specs.

```
taskspec/        Task Spec schema + loader/validator (see ../../docs/task-spec.md)
capabilities/
  ask_data/      Genie "talk to your data" tool
  ingest/        files/text/images → canonical rows (ai_parse_document / ai_extract)
  validate/      deterministic checks engine → findings (UC function)
  modify/        governed, idempotent, audited write/upsert (UC function)
  chase/         multi-channel outbound + escalation
supervisor/      ResponsesAgent tying capabilities as tools; MLflow-traced; gateway-registered
storage/         Lakebase (OLTP) + synced-tables-to-UC helpers
```

Build order: P0 `taskspec` + `supervisor` + `ask_data`; P1 `validate` + `modify` + `storage`;
P2 `ingest`; P3 `chase`. See ../../PLAN.md §6.
