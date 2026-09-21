#!/usr/bin/env python3
"""Generate hostile inputs the parser MUST reject within caps (no OOM/hang).

Expected IG### code (see harness manifest):
  wrongmagic.xlsx      -> IG001  (not a ZIP/OOXML container)
  ole2.xlsx            -> IG015  (OLE2 magic: legacy .xls / unsupported — distinct from encrypted)
  encrypted.xlsx       -> IG003  (OOXML with EncryptionInfo member)
  macro.xlsm           -> IG002  (rejected by extension)
  vba.xlsx             -> IG002  (valid zip containing xl/vbaProject.bin)
  zipbomb.xlsx         -> IG005  (decompression ratio)
  manyrows.xlsx        -> IG006  (rows over cap; harness uses small max_rows)
  formula_amount.xlsx  -> IG010  (formula in a money column, no cached value)
  two_sheets.xlsx      -> IG011  (two visible sheets both bind -> ambiguous)
"""
from __future__ import annotations
import io, pathlib, zipfile
import openpyxl

OUT = pathlib.Path(__file__).resolve().parent
HEADER = ["remittance_id", "invoice_id", "amount", "pay_date"]


def _valid_wb_bytes(fill=True):
    buf = io.BytesIO(); wb = openpyxl.Workbook(); ws = wb.active
    ws.append(HEADER)
    if fill:
        ws.append(["R1", "INV1", 100.0, "2026-01-15"])
    wb.save(buf); return buf.getvalue()


def main():
    for pat in ("*.xlsx", "*.xlsm"):
        for f in OUT.glob(pat):
            f.unlink()

    (OUT / "wrongmagic.xlsx").write_bytes(b"this is plainly not a spreadsheet\n")
    (OUT / "ole2.xlsx").write_bytes(b"\xd0\xcf\x11\xe0" + b"\x00" * 512)
    (OUT / "macro.xlsm").write_bytes(b"PK\x03\x04" + b"\x00" * 64)

    # OOXML zip carrying an EncryptionInfo member -> encrypted
    with zipfile.ZipFile(OUT / "encrypted.xlsx", "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", b"<x/>"); z.writestr("EncryptionInfo", b"\x00" * 32)

    # valid xlsx + injected vbaProject.bin
    zin = zipfile.ZipFile(io.BytesIO(_valid_wb_bytes()))
    with zipfile.ZipFile(OUT / "vba.xlsx", "w", zipfile.ZIP_DEFLATED) as zout:
        for item in zin.infolist():
            zout.writestr(item, zin.read(item.filename))
        zout.writestr("xl/vbaProject.bin", b"\x00" * 128)

    # zip-bomb: 50 MB zeros compresses tiny -> ratio >> cap
    with zipfile.ZipFile(OUT / "zipbomb.xlsx", "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", b"<x/>"); z.writestr("xl/big.bin", b"\x00" * (50 * 1024 * 1024))

    # many rows (valid) -> tripped by a small max_rows in the harness
    wb = openpyxl.Workbook(); ws = wb.active; ws.append(HEADER)
    for i in range(12):
        ws.append([f"R{i}", f"INV{i}", 1.00, "2026-01-01"])
    wb.save(OUT / "manyrows.xlsx")

    # formula in the amount column with NO cached value (openpyxl-written)
    wb = openpyxl.Workbook(); ws = wb.active; ws.append(HEADER)
    ws.append(["R1", "INV1", "=1+1", "2026-01-15"])
    wb.save(OUT / "formula_amount.xlsx")

    # two visible sheets that BOTH bind -> ambiguous, must reject
    wb = openpyxl.Workbook(); a = wb.active; a.title = "Jan"; b = wb.create_sheet("Feb")
    for ws in (a, b):
        ws.append(HEADER); ws.append(["R1", "INV1", 100.0, "2026-01-15"])
    wb.save(OUT / "two_sheets.xlsx")

    print("hostile files written to", OUT)


if __name__ == "__main__":
    main()
