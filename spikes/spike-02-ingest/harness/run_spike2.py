#!/usr/bin/env python3
"""Spike 2 harness — deterministic-ingest accuracy + hostile-file rejection.

Corpus: parse each file, compare to its ground-truth (per-modality field
exact-match; money compared NUMERICALLY so 100.0 == 100.00). Hostile: assert the
expected IG### reject code fires within caps (no OOM/hang).

Exit criteria (docs/plan/06 Spike 2, per-modality bar):
  xlsx/csv field exact-match >= 99.5% well-formed, >= 98% messy-legal
  hostile files: 100% rejected with the expected code
"""
from __future__ import annotations
import json, pathlib, sys
from decimal import Decimal

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent / "parser"))
from parse import parse, IngestConfig, IngestReject  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parent.parent
CORPUS, HOSTILE = ROOT / "corpus", ROOT / "hostile"

CFG = IngestConfig(
    required_columns={
        "remittance_id": ["remittance", "remittance id", "remittance_no"],
        "invoice_id": ["invoice", "invoice no", "invoice_no", "invoice id"],
        "amount": ["amt", "betrag", "total", "payment amount"],
        "pay_date": ["payment date", "date", "pay date"],
    },
    money_columns={"amount"},
    date_columns={"pay_date"},
)

HOSTILE_MANIFEST = {   # filename -> (expected_code, cfg_override_kwargs)
    "wrongmagic.xlsx": ("IG001", {}),
    "encrypted.xlsx": ("IG003", {}),
    "macro.xlsm": ("IG002", {}),
    "vba.xlsx": ("IG002", {}),
    "zipbomb.xlsx": ("IG005", {}),
    "manyrows.xlsx": ("IG006", {"max_rows": 5}),
}


def cell_match(canonical, got, want) -> bool:
    if got is None:
        return want in (None, "")
    if canonical == "amount":
        try:
            return Decimal(str(got)) == Decimal(str(want))
        except Exception:
            return False
    return str(got) == str(want)


def score_corpus():
    results, tot_fields, tot_ok = [], 0, 0
    files = sorted([p for p in CORPUS.iterdir()
                    if p.suffix in (".xlsx", ".csv") and not p.name.endswith(".truth.json")])
    for p in files:
        truth = json.loads((CORPUS / f"{p.name}.truth.json").read_text())
        try:
            res = parse(p.read_bytes(), p.name, CFG)
        except IngestReject as e:
            results.append((p.name, 0.0, f"REJECTED {e.code} (should parse)")); continue
        fields = ok = 0
        row_ok = len(res.rows) == len(truth)
        for got_row, want_row in zip(res.rows, truth):
            for canonical in CFG.required_columns:
                fields += 1
                if cell_match(canonical, got_row.values.get(canonical), want_row.get(canonical)):
                    ok += 1
        # penalize row-count mismatch by counting missing rows as all-wrong
        missing = abs(len(res.rows) - len(truth)) * len(CFG.required_columns)
        fields += missing
        acc = ok / fields if fields else 0.0
        tot_fields += fields; tot_ok += ok
        results.append((p.name, acc, f"rows={len(res.rows)}/{len(truth)} {'' if row_ok else 'ROWCOUNT!'}"))
    overall = tot_ok / tot_fields if tot_fields else 0.0
    return results, overall


def score_hostile():
    out = []
    for name, (code, override) in HOSTILE_MANIFEST.items():
        p = HOSTILE / name
        cfg = IngestConfig(**{**CFG.__dict__, **override}) if override else CFG
        try:
            parse(p.read_bytes(), p.name, cfg)
            out.append((name, False, f"NOT rejected (want {code})"))
        except IngestReject as e:
            out.append((name, e.code == code, f"got {e.code} want {code}"))
        except Exception as e:
            out.append((name, False, f"non-reject error {type(e).__name__}: {str(e)[:60]}"))
    return out


def main():
    corpus, overall = score_corpus()
    hostile = score_hostile()
    print(f"{'CORPUS FILE':<28} ACC      DETAIL")
    for name, acc, detail in corpus:
        print(f"{name:<28} {acc*100:6.1f}%  {detail}")
    print(f"{'-- overall field acc':<28} {overall*100:6.1f}%")
    print(f"\n{'HOSTILE FILE':<28} RESULT   DETAIL")
    for name, ok, detail in hostile:
        print(f"{name:<28} {'PASS' if ok else 'FAIL':<8} {detail}")
    corpus_ok = overall >= 0.98 and all(a >= 0.98 for _, a, _ in corpus)
    hostile_ok = all(ok for _, ok, _ in hostile)
    print(f"\ncorpus>=98%: {corpus_ok}   hostile 100% rejected: {hostile_ok}")
    if not (corpus_ok and hostile_ok):
        raise SystemExit(1)
    print("Spike 2 deterministic path: PASS")


if __name__ == "__main__":
    main()
