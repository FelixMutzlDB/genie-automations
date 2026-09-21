# Spike 2 — deterministic xlsx/image ingest

Spec: [`../../docs/plan/06-spike-specs.md`](../../docs/plan/06-spike-specs.md)
(Spike 2). Not yet scaffolded — Spike 1 is the critical path (it gates the
commit contract and the period-lock decision). This directory is a placeholder
so the spike is tracked.

## To scaffold (when Spike 1 is under way)

- `corpus/` — ~30 messy xlsx (multi-sheet, merged headers, totals rows, hidden
  rows, locale numbers, date serials) + csv, each with a ground-truth canonical
  rowset. Use `databricks-synthetic-data-gen` to build realistic messy inputs.
- `hostile/` — zip-bomb, `.xlsm` macro, encrypted, wrong-magic-byte, 2M-row.
- `parser/` — deterministic xlsx/csv reader (openpyxl/pandas): cached-values-not-
  formulas, magic-byte check, decompression-ratio + size/row/col caps, locale
  numbers, date-serial→ISO, merged-header confidence → reject-on-ambiguity.
- `image/` — vision-FM-in-endpoint vs `ai_parse_document`-in-Job; measure
  latency + payload + accuracy. Route via `databricks-ai-functions`.

## Exit criteria

- deterministic xlsx/csv field exact-match ≥ 99.5% well-formed, ≥ 98% messy-legal
- hostile files 100% rejected within caps (no OOM/hang)
- interactive image p95 latency < 8 s under a payload ceiling
- **separate ground-truth per modality**; set a per-modality accuracy bar
  (fix #11) — no cross-population "−2 pts"
- human-confirm mandatory for the probabilistic path regardless of the bar
