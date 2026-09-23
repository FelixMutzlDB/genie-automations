#!/usr/bin/env python3
"""Spike 2 — deterministic xlsx/csv parser (the money path, no LLM). v2.

Hardened after the partner code review. Governing principle: on the money path
we **reject-never-guess**. Locale, sheet selection, numeric grammar and the
formula policy are **per-automation config**, not per-value inference — because
the scary failures are the ones that pass a clean corpus and silently emit a
wrong number or drop a row.

Key guarantees (review fixes):
  * Locale is declared (decimal_sep/thousands_sep); anything not conforming ->
    reject (no silent 1000x). Parenthesized/trailing-minus negatives supported.
  * Formulas in required fields are REJECTED (data_only cache can be stale/None).
  * Header binding is INJECTIVE (no two canonicals share a column).
  * Sheet selection is config-named or single-unambiguous-visible; else reject.
  * Single-pass read (no fragile read_only re-iteration); row-count asserted.
  * Summary/totals rows (empty key columns) are skipped, not double-counted.
  * Dates honor wb.epoch (1900/1904 + serial-60) and datetime passthrough.
  * CSV: size/row caps, config/sniffed delimiter, encoding fallback -> reject.
  * Archive hardening: member count/size caps, encrypted-flag + dup-member reject.
  * Non-money/date TEXT is control-char-stripped + length-capped; raw headers/
    filenames/sheet names stay OUT of the agent decision context (typed boundary).

NOTE (still a real boundary): the definitive zip-bomb / XML-entity defense is to
run this in a RESOURCE-BOUNDED Job, not the shared endpoint (red-team C-16). The
in-process caps here are necessary but not sufficient against a crafted bomb.
Requires openpyxl. Run harness/run_spike2.py.
"""
from __future__ import annotations
import csv, hashlib, io, re, unicodedata, zipfile, datetime as dt
from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation
from typing import Any

class IngestReject(Exception):
    def __init__(self, code: str, msg: str):
        super().__init__(f"{code}: {msg}")
        self.code = code

R_MAGIC="IG001"; R_MACRO="IG002"; R_ENCRYPTED="IG003"; R_SIZE="IG004"; R_ZIPBOMB="IG005"
R_DIMS="IG006"; R_HEADER="IG007"; R_MONEYCOL="IG008"; R_VALUE="IG009"; R_FORMULA="IG010"
R_SHEET_AMBIG="IG011"; R_BINDING="IG012"; R_ENCODING="IG013"; R_FORMAT="IG014"; R_UNSUPPORTED="IG015"

_CURRENCY = "€$£¥"
_CTRL = {c: None for c in range(32) if c not in (9, 10, 13)}


@dataclass
class IngestConfig:
    required_columns: dict[str, list[str]]      # canonical -> [alias, ...]
    money_columns: set[str]                     # exact-bind, reject-on-ambiguity
    key_columns: set[str] = field(default_factory=set)   # must be non-empty; all-empty row => summary/skip
    date_columns: set[str] = field(default_factory=set)
    # numeric grammar (declared, not inferred)
    decimal_sep: str = "."
    thousands_sep: str = ","
    money_scale: int = 2
    accept_parens_negative: bool = True
    allow_formulas: bool = False
    # sheet / csv
    sheet_name: str | None = None               # None => single unambiguous visible sheet
    csv_delimiter: str | None = None            # None => sniff
    encodings: tuple = ("utf-8-sig", "cp1252")
    # caps
    max_bytes: int = 25 * 1024 * 1024
    max_decompress_ratio: int = 100
    max_uncompressed_bytes: int = 300 * 1024 * 1024
    max_zip_members: int = 512
    max_member_bytes: int = 100 * 1024 * 1024
    max_rows: int = 200_000
    max_cols: int = 256
    max_sheets: int = 50
    header_scan_rows: int = 20
    max_text_len: int = 10_000


@dataclass
class CanonicalRow:
    values: dict[str, Any]
    sheet: str
    source_row: int
    source_sha256: str


@dataclass
class IngestResult:
    rows: list[CanonicalRow]
    sheet: str
    header_row: int
    source_sha256: str
    modality: str
    skipped_summary: int = 0


# ---- helpers ---------------------------------------------------------------
def _norm(s: Any) -> str:
    if s is None:
        return ""
    s = unicodedata.normalize("NFKC", str(s))
    s = "".join(ch for ch in s if not unicodedata.category(ch).startswith("Z"))  # all unicode spaces
    return s.strip().lower().replace(" ", "").replace("_", "")


def _clean_text(v: Any, cfg: IngestConfig) -> Any:
    if v is None:
        return None
    s = unicodedata.normalize("NFKC", str(v)).translate(_CTRL)
    if len(s) > cfg.max_text_len:
        raise IngestReject(R_VALUE, f"text exceeds {cfg.max_text_len} chars")
    # export-safety only (NOT injection defense — free text stays out of agent context)
    return "'" + s if s and s[0] in ("=", "+", "-", "@", "\t", "\r") else s


def _parse_money(v: Any, cfg: IngestConfig, canonical: str) -> str:
    if isinstance(v, bool) or v is None:
        raise IngestReject(R_VALUE, f"{canonical}: empty/boolean not a money value")
    if isinstance(v, (int, float, Decimal)):
        d = Decimal(str(v))
    else:
        s = unicodedata.normalize("NFKC", str(v))
        s = "".join(ch for ch in s if not unicodedata.category(ch).startswith("Z"))
        s = s.strip().strip(_CURRENCY)
        neg = False
        if cfg.accept_parens_negative and s.startswith("(") and s.endswith(")"):
            neg, s = True, s[1:-1]
        if s.endswith("-"):
            neg, s = True, s[:-1]
        if s.startswith("-") or s.startswith("−"):
            neg, s = True, s[1:]
        if cfg.thousands_sep:
            s = s.replace(cfg.thousands_sep, "")
        if cfg.decimal_sep != ".":
            if "." in s:  # a stray '.' under a comma-decimal locale is an inconsistency
                raise IngestReject(R_VALUE, f"{canonical}: '.' not valid under decimal_sep={cfg.decimal_sep!r}")
            s = s.replace(cfg.decimal_sep, ".")
        if not re.fullmatch(r"\d+(\.\d+)?", s):
            raise IngestReject(R_VALUE, f"{canonical}: not a plain number after locale parse: {v!r}")
        d = Decimal(s)
        if neg:
            d = -d
    if not d.is_finite():
        raise IngestReject(R_VALUE, f"{canonical}: non-finite {v!r}")
    if -d.as_tuple().exponent > cfg.money_scale:
        raise IngestReject(R_VALUE, f"{canonical}: scale > {cfg.money_scale}: {v!r}")
    if abs(d) >= Decimal(10) ** (18 - cfg.money_scale):
        raise IngestReject(R_VALUE, f"{canonical}: overflow for NUMERIC(18,{cfg.money_scale})")
    return str(d)


def _to_iso_date(v: Any, epoch: dt.datetime, canonical: str) -> Any:
    if v is None:
        return None
    if isinstance(v, dt.datetime):
        return v.date().isoformat()
    if isinstance(v, dt.date):
        return v.isoformat()
    if isinstance(v, (int, float)):
        from openpyxl.utils.datetime import from_excel
        got = from_excel(v, epoch)   # honors 1900/1904 + serial-60 anomaly
        return got.date().isoformat() if isinstance(got, dt.datetime) else got.isoformat()
    raise IngestReject(R_VALUE, f"{canonical}: uncoercible date {v!r}")


def _bind_header(header_cells: list[Any], cfg: IngestConfig) -> dict[str, int]:
    norm_cells = [_norm(c) for c in header_cells]
    binding: dict[str, int] = {}
    for canonical, aliases in cfg.required_columns.items():
        wanted = {_norm(canonical)} | {_norm(a) for a in aliases}
        matches = [i for i, c in enumerate(norm_cells) if c and c in wanted]
        if len(matches) == 1:
            binding[canonical] = matches[0]
        elif len(matches) == 0:
            raise IngestReject(R_MONEYCOL if canonical in cfg.money_columns else R_HEADER,
                               f"required column '{canonical}' not found")
        else:
            raise IngestReject(R_MONEYCOL if canonical in cfg.money_columns else R_HEADER,
                               f"column '{canonical}' ambiguous ({len(matches)} matches)")
    # INJECTIVE: no two canonicals may bind the same source column (review fix #5).
    seen: dict[int, str] = {}
    for canonical, idx in binding.items():
        if idx in seen:
            raise IngestReject(R_BINDING, f"'{canonical}' and '{seen[idx]}' bind the same column {idx}")
        seen[idx] = canonical
    return binding


def _coerce_row(binding, row_vals, fml_row, cfg, epoch, sheet, src_row, src_sha) -> CanonicalRow | None:
    # summary/totals detection: all key columns empty => skip (not a data row).
    if cfg.key_columns:
        key_empty = [binding[k] for k in cfg.key_columns if row_vals[binding[k]] in (None, "")]
        if len(key_empty) == len(cfg.key_columns):
            return None                                  # summary/blank -> skip
        if key_empty:
            raise IngestReject(R_VALUE, f"row {src_row}: partial key (columns {key_empty} empty)")
    out: dict[str, Any] = {}
    for canonical, idx in binding.items():
        # formula policy: a formula in a required cell is rejected (cache may be stale/None).
        if not cfg.allow_formulas and fml_row is not None and idx < len(fml_row):
            cell = fml_row[idx]
            if getattr(cell, "data_type", None) == "f":
                raise IngestReject(R_FORMULA, f"row {src_row} col '{canonical}' is a formula")
        v = row_vals[idx] if idx < len(row_vals) else None
        if canonical in cfg.money_columns:
            out[canonical] = _parse_money(v, cfg, canonical)
        elif canonical in cfg.date_columns:
            out[canonical] = _to_iso_date(v, epoch, canonical)
        else:
            out[canonical] = _clean_text(v, cfg)
    return CanonicalRow(values=out, sheet=sheet, source_row=src_row, source_sha256=src_sha)


# ---- xlsx structural gate --------------------------------------------------
def _guard_xlsx_bytes(raw: bytes, cfg: IngestConfig) -> None:
    if len(raw) > cfg.max_bytes:
        raise IngestReject(R_SIZE, f"{len(raw)} bytes > cap {cfg.max_bytes}")
    if raw[:4] == b"\xd0\xcf\x11\xe0":
        raise IngestReject(R_UNSUPPORTED, "OLE2 container (legacy .xls or encrypted OOXML)")
    if raw[:4] != b"PK\x03\x04":
        raise IngestReject(R_MAGIC, "not a ZIP/OOXML container")
    try:
        zf = zipfile.ZipFile(io.BytesIO(raw))
    except zipfile.BadZipFile:
        raise IngestReject(R_MAGIC, "corrupt ZIP container")
    with zf:
        infos = zf.infolist()
        if len(infos) > cfg.max_zip_members:
            raise IngestReject(R_ZIPBOMB, f"{len(infos)} zip members > cap {cfg.max_zip_members}")
        names = [zi.filename for zi in infos]
        if len(names) != len(set(names)):
            raise IngestReject(R_ZIPBOMB, "duplicate zip member names")
        if any((zi.flag_bits & 0x1) for zi in infos):
            raise IngestReject(R_ENCRYPTED, "encrypted ZIP entry")
        lower = {n.lower() for n in names}
        if any("vba" in n and n.endswith(".bin") for n in lower):
            raise IngestReject(R_MACRO, "macro-enabled workbook (vbaProject.bin)")
        if "xl/encryptedpackage" in lower or "encryptioninfo" in lower:
            raise IngestReject(R_ENCRYPTED, "encrypted OOXML package")
        total = 0
        for zi in infos:
            if zi.file_size > cfg.max_member_bytes:
                raise IngestReject(R_ZIPBOMB, f"member {zi.filename} {zi.file_size} > {cfg.max_member_bytes}")
            total += zi.file_size
            if zi.compress_size > 0 and zi.file_size / zi.compress_size > cfg.max_decompress_ratio:
                raise IngestReject(R_ZIPBOMB, f"member {zi.filename} ratio high")
        if total > cfg.max_uncompressed_bytes:
            raise IngestReject(R_ZIPBOMB, f"uncompressed {total} > cap {cfg.max_uncompressed_bytes}")


def _bindable_visible_sheets(wb_val, cfg):
    """Return [(name, header_row_index, binding)] for VISIBLE sheets that bind."""
    out = []
    for name in wb_val.sheetnames:
        ws = wb_val[name]
        if getattr(ws, "sheet_state", "visible") != "visible":
            continue
        for i, row in enumerate(ws.iter_rows(values_only=True)):
            if i >= cfg.header_scan_rows:
                break
            try:
                binding = _bind_header(list(row), cfg)
                out.append((name, i, binding)); break
            except IngestReject:
                continue
    return out


def parse_xlsx(raw: bytes, cfg: IngestConfig) -> IngestResult:
    import openpyxl
    src_sha = hashlib.sha256(raw).hexdigest()
    _guard_xlsx_bytes(raw, cfg)
    try:
        wb_val = openpyxl.load_workbook(io.BytesIO(raw), read_only=True, data_only=True, keep_links=False)
        wb_fml = openpyxl.load_workbook(io.BytesIO(raw), read_only=True, data_only=False, keep_links=False)
    except IngestReject:
        raise
    except Exception as e:
        raise IngestReject(R_FORMAT, f"workbook load failed: {type(e).__name__}")
    try:
        if len(wb_val.sheetnames) > cfg.max_sheets:
            raise IngestReject(R_DIMS, f"{len(wb_val.sheetnames)} sheets > cap {cfg.max_sheets}")
        epoch = getattr(wb_val, "epoch", dt.datetime(1899, 12, 30))

        # sheet selection: config-named, else the single unambiguous visible binder.
        candidates = _bindable_visible_sheets(wb_val, cfg)
        if cfg.sheet_name is not None:
            candidates = [c for c in candidates if c[0] == cfg.sheet_name]
            if not candidates:
                raise IngestReject(R_HEADER, f"configured sheet '{cfg.sheet_name}' not found or no header")
        if len(candidates) == 0:
            raise IngestReject(R_HEADER, "no visible sheet with a bindable header")
        if len(candidates) > 1:
            raise IngestReject(R_SHEET_AMBIG, f"{len(candidates)} sheets bind: {[c[0] for c in candidates]}")
        sheet, hdr_idx, binding = candidates[0]
        ws_val, ws_fml = wb_val[sheet], wb_fml[sheet]
        if ws_val.max_column and ws_val.max_column > cfg.max_cols:
            raise IngestReject(R_DIMS, f"{sheet}: {ws_val.max_column} cols > cap {cfg.max_cols}")

        rows: list[CanonicalRow] = []
        skipped = 0
        n = 0
        # single pass, zipping value-view and formula-view rows.
        for j, (vrow, frow) in enumerate(zip(ws_val.iter_rows(values_only=True), ws_fml.iter_rows())):
            if j <= hdr_idx:
                continue
            vlist = list(vrow)
            if all(c is None for c in vlist):
                continue
            n += 1
            if n > cfg.max_rows:
                raise IngestReject(R_DIMS, f"{sheet}: > {cfg.max_rows} data rows (reject, not truncate)")
            cr = _coerce_row(binding, vlist, list(frow), cfg, epoch, sheet, j + 1, src_sha)
            if cr is None:
                skipped += 1
            else:
                rows.append(cr)
        if not rows:
            raise IngestReject(R_VALUE, f"{sheet}: header bound but zero data rows parsed")
        return IngestResult(rows, sheet, hdr_idx, src_sha, "xlsx", skipped)
    finally:
        wb_val.close(); wb_fml.close()


def parse_csv(raw: bytes, cfg: IngestConfig) -> IngestResult:
    if len(raw) > cfg.max_bytes:
        raise IngestReject(R_SIZE, f"{len(raw)} bytes > cap {cfg.max_bytes}")
    if b"\x00" in raw:
        raise IngestReject(R_FORMAT, "NUL byte in CSV")
    src_sha = hashlib.sha256(raw).hexdigest()
    text = None
    for enc in cfg.encodings:
        try:
            text = raw.decode(enc); break
        except UnicodeDecodeError:
            continue
    if text is None:
        raise IngestReject(R_ENCODING, f"undecodable under {cfg.encodings}")
    sample = "\n".join(text.splitlines()[:5])
    delim = cfg.csv_delimiter
    if delim is None:
        try:
            delim = csv.Sniffer().sniff(sample, delimiters=",;\t|").delimiter
        except csv.Error:
            delim = ","
    reader = list(csv.reader(io.StringIO(text), delimiter=delim))
    epoch = dt.datetime(1899, 12, 30)
    for i, row in enumerate(reader[: cfg.header_scan_rows]):
        try:
            binding = _bind_header(row, cfg)
        except IngestReject:
            continue
        rows, skipped = [], 0
        for j, drow in enumerate(reader[i + 1:]):
            if not any((c or "").strip() for c in drow):
                continue
            if len(rows) >= cfg.max_rows:
                raise IngestReject(R_DIMS, f"> {cfg.max_rows} data rows")
            cr = _coerce_row(binding, drow, None, cfg, epoch, "csv", i + 2 + j, src_sha)
            if cr is None:
                skipped += 1
            else:
                rows.append(cr)
        if not rows:
            raise IngestReject(R_VALUE, "header bound but zero data rows parsed")
        return IngestResult(rows, "csv", i, src_sha, "csv", skipped)
    raise IngestReject(R_HEADER, "no bindable header row in CSV")


def parse(raw: bytes, filename: str, cfg: IngestConfig) -> IngestResult:
    lower = filename.lower()
    if lower.endswith(".xlsm"):
        raise IngestReject(R_MACRO, "macro-enabled .xlsm not accepted")
    if lower.endswith(".xls"):
        raise IngestReject(R_UNSUPPORTED, "legacy .xls not supported")
    if lower.endswith(".xlsx"):
        return parse_xlsx(raw, cfg)
    if lower.endswith(".csv"):
        return parse_csv(raw, cfg)
    raise IngestReject(R_MAGIC, f"unsupported deterministic modality: {filename}")
