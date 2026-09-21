# Spike 2 — deterministic xlsx/csv ingest (+ untrusted Volume sandbox)

Spec: [`../../docs/plan/06-spike-specs.md`](../../docs/plan/06-spike-specs.md) (Spike 2)
and [`../../docs/plan/02-config-and-ingest-router-contract.md`](../../docs/plan/02-config-and-ingest-router-contract.md).

Proves the **money path** — xlsx/csv (the hard requirement) parsed by a
DETERMINISTIC reader so financial numbers never touch a probabilistic model
(ADR-005). Images / freeform chat use the probabilistic path (confidence-gated +
human-confirm) and are **not** built here yet.

## Status — deterministic path GREEN (local)

```
corpus:  6/6 files @ 100.0% field accuracy (clean xlsx/csv, header-offset+alias,
         German locale numbers, multi-sheet decoy, EN thousands)
hostile: 6/6 rejected with exact IG### code (wrong-magic, encrypted/OLE, .xlsm,
         injected vbaProject.bin, zip-bomb, over-row-cap)
```

## What this scaffold contains

| Path | Purpose |
|---|---|
| `parser/parse.py` | deterministic xlsx/csv reader: magic-byte gate, zip-bomb + size/rows/cols/sheets caps, `data_only` (cached values not formulas), strict money-column binding with **reject-on-ambiguity**, locale→Decimal, Excel-serial→ISO, formula-injection neutralization, per-row provenance (`source_sha256`, sheet, row). `IG###` reject codes. |
| `corpus/gen_corpus.py` | generates messy-but-legal xlsx/csv + per-file `*.truth.json` ground truth |
| `hostile/gen_hostile.py` | generates hostile inputs the parser must reject within caps |
| `harness/run_spike2.py` | accuracy (money compared numerically) + hostile-rejection harness with per-modality bar |

## Governed Volume (untrusted sandbox)

Created: `/Volumes/felix_demo_catalog/genie-automations/raw_uploads/` (managed).
All uploads land here FIRST as raw bytes (retain + SHA-256), treated as data
never instructions, validated before anything becomes writable.

## Run it (local — parser needs no Databricks)

```bash
python3 -m venv .venv && . .venv/bin/activate && pip install openpyxl
python corpus/gen_corpus.py && python hostile/gen_hostile.py
python harness/run_spike2.py
```

## Exit criteria (per-modality bar)

- xlsx/csv field exact-match ≥ 99.5% well-formed, ≥ 98% messy-legal ✅ (100% on current corpus)
- hostile files 100% rejected within caps (no OOM/hang) ✅
- human-confirm mandatory for the probabilistic (image/chat) path regardless of bar

## Still TODO (kept honest)

- **Merged-cell headers** and **bottom-of-sheet totals rows** — in the edge-case
  register; parser + corpus follow-up (would currently include a totals row as data).
- **Live Volume run** — upload the corpus to `raw_uploads/`, parse from the
  Volume path (prove the end-to-end untrusted-sandbox → deterministic-parse flow),
  and stage a canonical rowset for the Spike 1 commit path.
- **Image path** — vision-FM-in-endpoint vs `ai_parse_document`-in-Job; measure
  latency + payload + per-modality accuracy (route via `databricks-ai-functions`).
- **Broaden corpus** — larger messy set + adversarial-content (injection strings
  in text cells) to exercise the typed boundary.
