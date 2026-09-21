#!/usr/bin/env python3
"""Spike 2 image-path gate harness (local, no Databricks).

Simulates model extractions with confidence scores and asserts the gate's
invariants. The LIVE extraction (ai_query vision / ai_parse_document) is a
separate step needing Pro/Serverless warehouse or a DBR 17.3+ Job + an image on
the Volume — the exact SQL is in image_path.py; this proves the GATING logic that
every extracted row must pass regardless of mechanism.
"""
from __future__ import annotations
import sys, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent / "parser"))
from parse import IngestConfig                      # noqa: E402
from image_path import gate_extraction, ProbConfig  # noqa: E402

CFG = IngestConfig(
    required_columns={"remittance_id": [], "invoice_id": [], "amount": [], "pay_date": []},
    money_columns={"amount"}, date_columns={"pay_date"},
)
PROB = ProbConfig(min_field_confidence=0.90)


def check(name, ok, detail=""):
    print(f"{name:<52} {'PASS' if ok else 'FAIL':<6} {detail}")
    return ok


def main():
    results = []

    # 1. clean high-confidence extraction -> no flags, but STILL requires human confirmation
    hi = [{"values": {"remittance_id": "R1", "invoice_id": "INV1", "amount": "100.00", "pay_date": "2026-01-15"},
           "confidences": {"remittance_id": .99, "invoice_id": .99, "amount": .98, "pay_date": .97}}]
    r = gate_extraction(hi, CFG, PROB, stated_total="100.00")
    results.append(check("high-conf clean: no flags", r.total_flagged == 0, f"flagged={r.total_flagged}"))
    results.append(check("ALWAYS requires human confirmation", r.requires_human_confirmation and r.rows[0].requires_human_confirmation))
    results.append(check("cross-foot ok when Σ==total", r.cross_foot_ok is True))

    # 2. low-confidence money field -> flagged (cannot auto-fill)
    lo = [{"values": {"remittance_id": "R1", "invoice_id": "INV1", "amount": "100.00", "pay_date": "2026-01-15"},
           "confidences": {"remittance_id": .99, "invoice_id": .99, "amount": .55, "pay_date": .97}}]
    r = gate_extraction(lo, CFG, PROB)
    results.append(check("low-conf money -> flagged", any("amount:low_conf" in f for f in r.rows[0].flagged),
                         str(r.rows[0].flagged)))

    # 3. malformed model money string -> grammar reject (not silently coerced)
    bad = [{"values": {"remittance_id": "R1", "invoice_id": "INV1", "amount": "1O0..0", "pay_date": "2026-01-15"},
            "confidences": {"amount": .99, "remittance_id": .99, "invoice_id": .99, "pay_date": .99}}]
    r = gate_extraction(bad, CFG, PROB)
    results.append(check("malformed money -> grammar-flagged", any("amount:IG" in f for f in r.rows[0].flagged),
                         str(r.rows[0].flagged)))

    # 4. cross-foot mismatch -> flagged
    mm = [{"values": {"remittance_id": "R1", "invoice_id": "INV1", "amount": "100.00", "pay_date": "2026-01-15"},
           "confidences": {"remittance_id": .99, "invoice_id": .99, "amount": .99, "pay_date": .99}}]
    r = gate_extraction(mm, CFG, PROB, stated_total="250.00")
    results.append(check("cross-foot mismatch detected", r.cross_foot_ok is False, f"cross_foot_ok={r.cross_foot_ok}"))

    print()
    if not all(results):
        raise SystemExit(1)
    print("Image-path gate: PASS (probabilistic path is always human-confirmed + gated)")


if __name__ == "__main__":
    main()
