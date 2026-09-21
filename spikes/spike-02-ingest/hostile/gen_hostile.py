#!/usr/bin/env python3
"""Generate hostile inputs the parser MUST reject within caps (no OOM/hang).

Each maps to an expected IG### reject code (see harness manifest):
  wrongmagic.xlsx  -> IG001  (not a ZIP/OOXML container)
  encrypted.xlsx   -> IG003  (OLE2 magic D0CF11E0)
  macro.xlsm       -> IG002  (rejected by extension before open)
  vba.xlsx         -> IG002  (valid zip containing xl/vbaProject.bin)
  zipbomb.xlsx     -> IG005  (huge decompression ratio / uncompressed size)
  manyrows.xlsx    -> IG006  (rows over cap; harness uses a small max_rows)
"""
from __future__ import annotations
import io, pathlib, zipfile
import openpyxl

OUT = pathlib.Path(__file__).resolve().parent


def main():
    for f in OUT.glob("*.xlsx"): f.unlink()
    for f in OUT.glob("*.xlsm"): f.unlink()

    (OUT / "wrongmagic.xlsx").write_bytes(b"this is plainly not a spreadsheet\n")
    (OUT / "encrypted.xlsx").write_bytes(b"\xd0\xcf\x11\xe0" + b"\x00" * 512)  # OLE2 container
    (OUT / "macro.xlsm").write_bytes(b"PK\x03\x04" + b"\x00" * 64)             # rejected by extension

    # valid xlsx zip with an injected vbaProject.bin -> macro-enabled
    buf = io.BytesIO()
    wb = openpyxl.Workbook(); wb.active.append(["remittance_id", "invoice_id", "amount", "pay_date"]); wb.save(buf)
    data = buf.getvalue()
    zin = zipfile.ZipFile(io.BytesIO(data))
    with zipfile.ZipFile(OUT / "vba.xlsx", "w", zipfile.ZIP_DEFLATED) as zout:
        for item in zin.infolist():
            zout.writestr(item, zin.read(item.filename))
        zout.writestr("xl/vbaProject.bin", b"\x00" * 128)

    # zip-bomb: one entry of 50 MB zeros compresses to ~KB -> ratio >> cap
    with zipfile.ZipFile(OUT / "zipbomb.xlsx", "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", b"<x/>")
        z.writestr("xl/big.bin", b"\x00" * (50 * 1024 * 1024))

    # many rows (valid) -> tripped by a small max_rows in the harness
    wb = openpyxl.Workbook(); ws = wb.active
    ws.append(["remittance_id", "invoice_id", "amount", "pay_date"])
    for i in range(12):
        ws.append([f"R{i}", f"INV{i}", 1.00, "2026-01-01"])
    wb.save(OUT / "manyrows.xlsx")

    print("hostile files written to", OUT)


if __name__ == "__main__":
    main()
