#!/usr/bin/env python3
"""Generate a small messy-but-legal xlsx/csv corpus + per-file ground truth.

Each output file has a sidecar `<name>.truth.json` listing the exact canonical
rows the deterministic parser SHOULD produce. The harness compares parser output
to this ground truth (field exact-match). Covers the handled slice of the
edge-case register: header not on row 1, alias headers, locale numbers (de/en),
Excel date serials, blank/decoy rows, multi-sheet with decoy sheets.

NOT yet covered here (parser + corpus follow-up): merged-cell headers and
bottom-of-sheet totals rows — tracked in the README.
"""
from __future__ import annotations
import json, pathlib, datetime as dt
import openpyxl

OUT = pathlib.Path(__file__).resolve().parent
CANON = ["remittance_id", "invoice_id", "amount", "pay_date"]

# canonical rows shared across files (the "truth"); files vary only in PRESENTATION.
BASE_ROWS = [
    {"remittance_id": "R1", "invoice_id": "INV1", "amount": "100.00", "pay_date": "2026-01-15"},
    {"remittance_id": "R1", "invoice_id": "INV2", "amount": "1234.56", "pay_date": "2026-02-01"},
    {"remittance_id": "R2", "invoice_id": "INV3", "amount": "9999.99", "pay_date": "2026-03-31"},
]


def _serial(iso: str) -> int:
    d = dt.date.fromisoformat(iso)
    return (d - dt.date(1899, 12, 30)).days


def write_truth(name: str, rows: list[dict]):
    (OUT / f"{name}.truth.json").write_text(json.dumps(rows, indent=2))


def clean_xlsx():
    wb = openpyxl.Workbook(); ws = wb.active; ws.title = "Sheet1"
    ws.append(["remittance_id", "invoice_id", "amount", "pay_date"])
    for r in BASE_ROWS:
        ws.append([r["remittance_id"], r["invoice_id"], float(r["amount"]), dt.date.fromisoformat(r["pay_date"])])
    wb.save(OUT / "clean.xlsx"); write_truth("clean.xlsx", BASE_ROWS)


def header_offset_alias_xlsx():
    """Title rows above the header; alias column names; date as Excel serial."""
    wb = openpyxl.Workbook(); ws = wb.active; ws.title = "Data"
    ws.append(["DEUTZ AG — Receivables Export"]); ws.append(["Generated 2026-04-01"]); ws.append([])
    ws.append(["Remittance", "Invoice No", "Betrag", "Payment Date"])   # aliases
    for r in BASE_ROWS:
        ws.append([r["remittance_id"], r["invoice_id"], float(r["amount"]), _serial(r["pay_date"])])
    wb.save(OUT / "header_offset_alias.xlsx"); write_truth("header_offset_alias.xlsx", BASE_ROWS)


def locale_de_xlsx():
    """German locale numbers as TEXT (1.234,56); blank decoy row in the middle."""
    wb = openpyxl.Workbook(); ws = wb.active
    ws.append(["remittance_id", "invoice_id", "amount", "pay_date"])
    ws.append(["R1", "INV1", "100,00", "2026-01-15"])
    ws.append([None, None, None, None])                 # blank row -> skipped
    ws.append(["R1", "INV2", "1.234,56", "2026-02-01"])
    ws.append(["R2", "INV3", "9.999,99", "2026-03-31"])
    wb.save(OUT / "locale_de.xlsx"); write_truth("locale_de.xlsx", BASE_ROWS)


def multisheet_decoy_xlsx():
    """Target sheet is not first; decoy sheets lack the required columns."""
    wb = openpyxl.Workbook()
    d1 = wb.active; d1.title = "Cover"; d1.append(["notes", "value"]); d1.append(["hello", 1])
    d2 = wb.create_sheet("Summary"); d2.append(["kpi", "q1"]); d2.append(["dso", 42])
    ws = wb.create_sheet("Ledger")
    ws.append(["remittance_id", "invoice_id", "amount", "pay_date"])
    for r in BASE_ROWS:
        ws.append([r["remittance_id"], r["invoice_id"], float(r["amount"]), dt.date.fromisoformat(r["pay_date"])])
    wb.save(OUT / "multisheet_decoy.xlsx"); write_truth("multisheet_decoy.xlsx", BASE_ROWS)


def clean_csv():
    lines = ["remittance_id,invoice_id,amount,pay_date"]
    for r in BASE_ROWS:
        lines.append(f'{r["remittance_id"]},{r["invoice_id"]},{r["amount"]},{r["pay_date"]}')
    (OUT / "clean.csv").write_text("\n".join(lines) + "\n"); write_truth("clean.csv", BASE_ROWS)


def csv_en_thousands():
    lines = ["Remittance,Invoice No,Total,Payment Date",
             'R1,INV1,"100.00",2026-01-15',
             'R1,INV2,"1,234.56",2026-02-01',
             'R2,INV3,"9,999.99",2026-03-31']
    (OUT / "en_thousands.csv").write_text("\n".join(lines) + "\n"); write_truth("en_thousands.csv", BASE_ROWS)


def main():
    for f in OUT.glob("*.xlsx"): f.unlink()
    for f in OUT.glob("*.csv"): f.unlink()
    for f in OUT.glob("*.truth.json"): f.unlink()
    clean_xlsx(); header_offset_alias_xlsx(); locale_de_xlsx(); multisheet_decoy_xlsx()
    clean_csv(); csv_en_thousands()
    print("corpus written to", OUT)


if __name__ == "__main__":
    main()
