# Spikes

These are the **only** things to build right now. Generalized P1–P4 must not be
built until both spikes report. See [`../docs/plan/06-spike-specs.md`](../docs/plan/06-spike-specs.md)
for the full specs and [`../docs/plan/07-seam-fixes-and-open-decisions.md`](../docs/plan/07-seam-fixes-and-open-decisions.md)
for the decisions each spike ratifies.

| Spike | Proves | Also decides |
|---|---|---|
| [spike-01-lakebase-commit](spike-01-lakebase-commit/) | OBO identity → write, atomic promote+audit+outbox, idempotency replay safety, aggregate-root lock behavior | **period-lock scope** (measured), **Lakebase credential model** |
| [spike-02-ingest](spike-02-ingest/) | deterministic xlsx/csv accuracy, hostile-file rejection, interactive image latency | per-modality accuracy bars |

Both are Databricks builds. Route through the Databricks skills:
`databricks-lakebase` + `databricks-model-serving` (Spike 1),
`databricks-ai-functions` + `databricks-unity-catalog` (Spike 2).

**Profile:** not chosen yet — pick one from `databricks auth profiles` before
deploying. Nothing here auto-selects a profile.
