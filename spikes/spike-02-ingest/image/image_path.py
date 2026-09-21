#!/usr/bin/env python3
"""Spike 2 — probabilistic ingest path (images / freeform chat). Design + gate.

xlsx/csv go through the DETERMINISTIC parser (parse.py, no LLM). Images and
freeform chat are inherently probabilistic — so this path is **always
confidence-gated AND always human-confirmed**: a model-extracted money number is
NEVER auto-committed, regardless of confidence (ADR-005 + red-team C-12/C-13).

Two mechanisms (both feed THIS gate; see SQL constants below):
  * interactive paste  -> ai_query(vision FM, files => image)   in the serving endpoint
  * bulk images/PDFs   -> ai_parse_document + ai_extract (v2.1) in a DBR 17.3+ Job
`ai_extract` v2.1 returns per-field CONFIDENCE — that is the gate signal.

Guarantees enforced here:
  1. requires_human_confirmation is ALWAYS True on this path (never auto-commit).
  2. A money field below min_field_confidence is FLAGGED (cannot be auto-filled;
     a human must confirm/correct it) — never silently accepted.
  3. Extracted money strings still pass the SAME deterministic money grammar
     (_parse_money under the declared locale) — a model that emits a malformed or
     over-scale number is rejected, not coerced.
  4. Cross-foot: Σ line items must equal the stated/extracted total (± tolerance);
     mismatch is flagged for human review.
  5. Typed boundary: only enumerated typed fields + confidence codes reach the
     agent — never raw OCR text / model free-text (that stays out of the decision
     context, same rule as the deterministic path).
"""
from __future__ import annotations
import sys, pathlib
from dataclasses import dataclass, field
from decimal import Decimal

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent / "parser"))
from parse import IngestConfig, IngestReject, _parse_money  # noqa: E402

# --- exact live SQL for the two mechanisms (documented; run in the right compute) ---
SQL_BULK_AI_PARSE = """-- bulk images/PDFs, DBR 17.3+ Job (NOT SQL Warehouse Classic)
CREATE OR REPLACE TABLE staged_extractions AS
SELECT path,
  ai_extract(
    concat_ws('\\n', transform(parsed:document:elements, e -> e:content::STRING)),
    '{"remittance_id":{"type":"string"},"invoice_id":{"type":"string"},'
    || '"amount":{"type":"number"},"pay_date":{"type":"string"}}',
    map('version','2.1')                      -- v2.1 => per-field confidence + citations
  ) AS ex
FROM (SELECT path, ai_parse_document(content, map('version','2.0')) AS parsed
      FROM read_files('/Volumes/felix_demo_catalog/genie-automations/raw_uploads/', format => 'binaryFile')
      WHERE lower(path) RLIKE '\\\\.(png|jpg|jpeg|pdf)$')
WHERE parsed:error_status IS NULL;
-- read ex:response:<field>::... for value and ex:metadata:<field>:confidence for the gate signal
"""

SQL_INTERACTIVE_VISION = """-- interactive screenshot paste, in the serving endpoint (Pro/Serverless warehouse)
SELECT ai_query('databricks-claude-sonnet-4',
  'Extract the remittance table as JSON rows {remittance_id, invoice_id, amount, pay_date}. '
  'Return numbers verbatim; do not compute.',
  files => :image_bytes,
  responseFormat => '{"type":"json_object"}',
  failOnError => false) AS extracted;
-- extracted values then pass through gate_extraction() below (never auto-committed)
"""


@dataclass
class ProbConfig:
    min_field_confidence: float = 0.90
    min_row_confidence: float = 0.90
    cross_foot_tolerance: str = "0.00"      # exact by default


@dataclass
class GatedRow:
    values: dict
    confidences: dict
    flagged: list = field(default_factory=list)
    requires_human_confirmation: bool = True   # INVARIANT on this path


@dataclass
class GatedResult:
    rows: list
    total_flagged: int
    cross_foot_ok: bool | None
    requires_human_confirmation: bool = True


def gate_extraction(extracted_rows, cfg: IngestConfig, prob: ProbConfig, stated_total: str | None = None) -> GatedResult:
    """extracted_rows: [{"values": {canonical: raw}, "confidences": {canonical: float}}].
    Returns a gated result that ALWAYS requires human confirmation."""
    gated, total_flagged, running = [], 0, Decimal("0")
    for r in extracted_rows:
        vals, confs, flagged = {}, r.get("confidences", {}), []
        for canonical in cfg.required_columns:
            raw = r["values"].get(canonical)
            conf = confs.get(canonical, 0.0)
            if canonical in cfg.money_columns:
                # money grammar enforced even for model output (fix: never coerce silently)
                try:
                    vals[canonical] = _parse_money(raw, cfg, canonical)
                    running += Decimal(vals[canonical])
                except IngestReject as e:
                    vals[canonical] = None; flagged.append(f"{canonical}:{e.code}")
                if conf < prob.min_field_confidence:
                    flagged.append(f"{canonical}:low_conf({conf:.2f})")   # cannot auto-fill money
            else:
                vals[canonical] = raw
                if conf < prob.min_field_confidence:
                    flagged.append(f"{canonical}:low_conf({conf:.2f})")
        if flagged:
            total_flagged += 1
        gated.append(GatedRow(values=vals, confidences=confs, flagged=flagged))
    cross_ok = None
    if stated_total is not None:
        cross_ok = abs(running - Decimal(stated_total)) <= Decimal(prob.cross_foot_tolerance)
    return GatedResult(rows=gated, total_flagged=total_flagged, cross_foot_ok=cross_ok)
