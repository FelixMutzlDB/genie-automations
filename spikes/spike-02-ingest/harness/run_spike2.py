#!/usr/bin/env python3
"""Spike 2 harness — deterministic-ingest accuracy + hostile rejection + units.

Per-file config (locale/delimiter/sheet/dates are per-automation config now).
Money compared NUMERICALLY. Exit criteria (docs/plan/06 Spike 2, per-modality):
xlsx/csv field exact-match >= 98% messy-legal; hostile 100% rejected w/ exact code.
"""
from __future__ import annotations
import json, pathlib, sys, datetime as dt
from decimal import Decimal

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent / "parser"))
from parse import parse, IngestConfig, IngestReject, _bind_header, _to_iso_date, _parse_money  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parent.parent
CORPUS, HOSTILE = ROOT / "corpus", ROOT / "hostile"

BASE = dict(
    required_columns={
        "remittance_id": ["remittance", "remittance id"],
        "invoice_id": ["invoice", "invoice no", "invoice id"],
        "amount": ["amt", "betrag", "total", "payment amount"],
        "pay_date": ["payment date", "date", "pay date"],
    },
    money_columns={"amount"},
    key_columns={"remittance_id", "invoice_id"},
)

CORPUS_CFG = {
    "clean.xlsx": {"date_columns": {"pay_date"}},
    "header_offset_alias.xlsx": {"date_columns": {"pay_date"}},
    "locale_de.xlsx": {"date_columns": {"pay_date"}, "decimal_sep": ",", "thousands_sep": "."},
    "totals_row.xlsx": {"date_columns": {"pay_date"}},
    "multisheet_decoy.xlsx": {"date_columns": {"pay_date"}},
    "clean.csv": {},
    "en_thousands.csv": {},
    "german_semicolon.csv": {"decimal_sep": ",", "thousands_sep": ".", "csv_delimiter": ";", "encodings": ("cp1252",)},
}

HOSTILE_MANIFEST = {
    "wrongmagic.xlsx": ("IG001", {}), "ole2.xlsx": ("IG015", {}), "encrypted.xlsx": ("IG003", {}),
    "macro.xlsm": ("IG002", {}), "vba.xlsx": ("IG002", {}), "zipbomb.xlsx": ("IG005", {}),
    "manyrows.xlsx": ("IG006", {"max_rows": 5}), "formula_amount.xlsx": ("IG010", {}),
    "two_sheets.xlsx": ("IG011", {}),
}


def cell_match(canonical, got, want):
    if got is None:
        return want in (None, "")
    if canonical == "amount":
        try:
            return Decimal(str(got)) == Decimal(str(want))
        except Exception:
            return False
    return str(got) == str(want)


def score_corpus():
    results, tot, ok_tot = [], 0, 0
    for name, override in CORPUS_CFG.items():
        cfg = IngestConfig(**BASE, **override)
        want = json.loads((CORPUS / f"{name}.truth.json").read_text())
        try:
            res = parse((CORPUS / name).read_bytes(), name, cfg)
        except IngestReject as e:
            results.append((name, 0.0, f"REJECTED {e.code}")); continue
        fields = ok = 0
        for g, w in zip(res.rows, want):
            for c in BASE["required_columns"]:
                fields += 1
                if cell_match(c, g.values.get(c), w.get(c)):
                    ok += 1
        fields += abs(len(res.rows) - len(want)) * len(BASE["required_columns"])
        acc = ok / fields if fields else 0.0
        tot += fields; ok_tot += ok
        note = f"rows={len(res.rows)}/{len(want)}" + (f" skipped={res.skipped_summary}" if res.skipped_summary else "")
        results.append((name, acc, note))
    return results, (ok_tot / tot if tot else 0.0)


def score_hostile():
    out = []
    for name, (code, override) in HOSTILE_MANIFEST.items():
        cfg = IngestConfig(**BASE, **override)
        try:
            parse((HOSTILE / name).read_bytes(), name, cfg)
            out.append((name, False, f"NOT rejected (want {code})"))
        except IngestReject as e:
            out.append((name, e.code == code, f"got {e.code} want {code}"))
        except Exception as e:
            out.append((name, False, f"non-reject {type(e).__name__}: {str(e)[:50]}"))
    return out


def units():
    out = []
    # binding injectivity: two canonicals sharing an alias -> IG012
    try:
        _bind_header(["amount"], IngestConfig(required_columns={"a": ["amount"], "b": ["amount"]},
                                              money_columns={"a", "b"}))
        out.append(("unit: injective binding rejects dup", False, "no reject"))
    except IngestReject as e:
        out.append(("unit: injective binding rejects dup", e.code == "IG012", f"got {e.code}"))
    # date: excel serial (1900 sys) + datetime passthrough -> ISO
    s = _to_iso_date(46037, dt.datetime(1899, 12, 30), "d")
    d = _to_iso_date(dt.datetime(2026, 2, 1, 9, 0), dt.datetime(1899, 12, 30), "d")
    out.append(("unit: date serial+datetime -> ISO", s == "2026-01-15" and d == "2026-02-01", f"{s},{d}"))
    # money: parenthesized negative under German locale
    cfg_de = IngestConfig(required_columns={}, money_columns=set(), decimal_sep=",", thousands_sep=".")
    neg = _parse_money("(1.234,56)", cfg_de, "amount")
    out.append(("unit: parens-neg + de-locale", neg == "-1234.56", f"{neg}"))
    # locale pinned, no per-value guess: '1.234' is 1234 under de; under en it's 3dp -> scale-rejected
    de = _parse_money("1.234", cfg_de, "amount")
    try:
        _parse_money("1.234", IngestConfig(required_columns={}, money_columns=set()), "amount")
        en_rej = False
    except IngestReject:
        en_rej = True
    out.append(("unit: locale pinned (no silent 1000x)", de == "1234" and en_rej, f"de={de} en_rejected={en_rej}"))
    return out


def main():
    corpus, overall = score_corpus()
    hostile = score_hostile()
    unit = units()
    print(f"{'CORPUS FILE':<26} ACC      DETAIL")
    for n, a, d in corpus:
        print(f"{n:<26} {a*100:6.1f}%  {d}")
    print(f"{'-- overall field acc':<26} {overall*100:6.1f}%")
    print(f"\n{'HOSTILE FILE':<26} RESULT   DETAIL")
    for n, ok, d in hostile:
        print(f"{n:<26} {'PASS' if ok else 'FAIL':<8} {d}")
    print(f"\n{'UNIT':<40} RESULT   DETAIL")
    for n, ok, d in unit:
        print(f"{n:<40} {'PASS' if ok else 'FAIL':<8} {d}")
    corpus_ok = overall >= 0.98 and all(a >= 0.98 for _, a, _ in corpus)
    hostile_ok = all(ok for _, ok, _ in hostile)
    unit_ok = all(ok for _, ok, _ in unit)
    print(f"\ncorpus>=98%: {corpus_ok}   hostile 100%: {hostile_ok}   units: {unit_ok}")
    if not (corpus_ok and hostile_ok and unit_ok):
        raise SystemExit(1)
    print("Spike 2 deterministic path: PASS")


if __name__ == "__main__":
    main()
