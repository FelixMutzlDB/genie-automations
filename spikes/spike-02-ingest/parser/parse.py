#!/usr/bin/env python3
"""Spike 2 — deterministic xlsx/csv parser (the money path, no LLM).

Encodes docs/plan/02-config-and-ingest-router-contract.md and the xlsx
edge-case register. XLSX and CSV are the HARD requirement and go through THIS
deterministic reader so financial numbers never touch a probabilistic model
(ADR-005). Images / freeform chat use the probabilistic path elsewhere
(confidence-gated + human-confirm) — not here.

Design rules enforced:
  * Untrusted-first: validate magic bytes + structure BEFORE opening; treat all
    content as DATA never instructions.
  * Reject-never-guess for money columns: strict canonical binding via an alias
    map; ambiguous header -> REJECT (IngestReject), never a silent mis-map.
  * Cached values, not formulas (data_only=True) — never evaluate a workbook.
  * Caps: file size, decompression ratio (zip-bomb), rows, cols, sheets.
  * Reject .xlsm / encrypted / wrong-magic-byte.
  * Locale numbers -> Decimal; Excel date serials -> ISO.
  * Formula-injection neutralized on any human-facing string cell.
  * Every canonical row carries provenance: source_sha256, sheet, source_row.

This is a scaffold: the caps/aliases come from the task's genie_automations_config
in prod; here they're passed as an IngestConfig. Requires openpyxl (see
requirements.txt). Run the harness (run_spike2.py) against corpus/ + hostile/.
"""
from __future__ import annotations
import csv, hashlib, io, zipfile, datetime as dt
from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation
from typing import Any

# ---- reject codes (mirror the GA### style of Spike 1) ----------------------
class IngestReject(Exception):
    def __init__(self, code: str, msg: str):
        super().__init__(f"{code}: {msg}")
        self.code = code

R_MAGIC       = "IG001"   # wrong / disallowed magic bytes
R_MACRO       = "IG002"   # .xlsm / macro-enabled
R_ENCRYPTED   = "IG003"   # encrypted / OLE container
R_SIZE        = "IG004"   # exceeds size cap
R_ZIPBOMB     = "IG005"   # decompression ratio / entry-size cap
R_DIMS        = "IG006"   # too many rows / cols / sheets
R_HEADER      = "IG007"   # header not found / ambiguous
R_MONEYCOL    = "IG008"   # required money column unbound / ambiguous
R_VALUE       = "IG009"   # uncoercible value in a typed column


@dataclass
class IngestConfig:
    # from genie_automations_config.header_aliases + validation policy (per task).
    required_columns: dict[str, list[str]]      # canonical -> [alias, ...] (case/space-insensitive)
    money_columns: set[str]                     # canonical names that MUST bind exactly (reject-on-ambiguity)
    date_columns: set[str] = field(default_factory=set)
    max_bytes: int = 25 * 1024 * 1024           # 25 MB
    max_decompress_ratio: int = 100             # zip-bomb guard
    max_uncompressed_bytes: int = 300 * 1024 * 1024
    max_rows: int = 200_000
    max_cols: int = 256
    max_sheets: int = 50
    header_scan_rows: int = 20                  # look this deep for the header row


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


# ---- helpers ---------------------------------------------------------------
def _norm(s: Any) -> str:
    return str(s).strip().lower().replace(" ", "").replace("_", "") if s is not None else ""


def _neutralize_formula(s: str) -> str:
    """Prevent formula injection in human-facing exports (=, +, -, @, tab, CR)."""
    if s and s[0] in ("=", "+", "-", "@", "\t", "\r"):
        return "'" + s
    return s


def _to_decimal(v: Any, canonical: str) -> Decimal:
    if isinstance(v, (int, float, Decimal)):
        try:
            return Decimal(str(v))
        except InvalidOperation:
            raise IngestReject(R_VALUE, f"{canonical}: uncoercible number {v!r}")
    s = str(v).strip()
    # locale: strip currency/space, handle 1.234,56 (de) and 1,234.56 (en)
    s = s.replace(" ", "").replace(" ", "").lstrip("€$£").rstrip("€$£")
    if "," in s and "." in s:
        if s.rfind(",") > s.rfind("."):          # comma is decimal sep (de)
            s = s.replace(".", "").replace(",", ".")
        else:                                     # comma is thousands sep (en)
            s = s.replace(",", "")
    elif "," in s:
        # ambiguous single comma: treat as decimal if 1-2 trailing digits
        head, _, tail = s.rpartition(",")
        s = f"{head}.{tail}" if len(tail) in (1, 2) else s.replace(",", "")
    try:
        return Decimal(s)
    except InvalidOperation:
        raise IngestReject(R_VALUE, f"{canonical}: uncoercible number {v!r}")


def _excel_serial_to_iso(v: Any) -> str:
    if isinstance(v, (dt.datetime, dt.date)):
        return v.date().isoformat() if isinstance(v, dt.datetime) else v.isoformat()
    if isinstance(v, (int, float)):
        # Excel epoch 1899-12-30 (accounts for the 1900 leap-year bug)
        return (dt.date(1899, 12, 30) + dt.timedelta(days=int(v))).isoformat()
    return str(v)


# ---- magic-byte / structural gate (BEFORE opening) -------------------------
def _guard_xlsx_bytes(raw: bytes, cfg: IngestConfig) -> None:
    if len(raw) > cfg.max_bytes:
        raise IngestReject(R_SIZE, f"{len(raw)} bytes > cap {cfg.max_bytes}")
    # OLE2 (old .xls / encrypted OOXML) starts with D0 CF 11 E0
    if raw[:4] == b"\xd0\xcf\x11\xe0":
        raise IngestReject(R_ENCRYPTED, "OLE2 container (encrypted or legacy .xls)")
    if raw[:4] != b"PK\x03\x04":
        raise IngestReject(R_MAGIC, "not a ZIP/OOXML container")
    try:
        zf = zipfile.ZipFile(io.BytesIO(raw))
    except zipfile.BadZipFile:
        raise IngestReject(R_MAGIC, "corrupt ZIP container")
    names = zf.namelist()
    # macro-enabled workbook -> reject
    if any(n.lower() == "xl/vbaproject.bin" for n in names) or any(n.endswith(".bin") and "vba" in n.lower() for n in names):
        raise IngestReject(R_MACRO, "macro-enabled workbook (vbaProject.bin)")
    if "xl/encryptedPackage" in names or "EncryptionInfo" in names:
        raise IngestReject(R_ENCRYPTED, "encrypted OOXML package")
    total_uncompressed = 0
    for zi in zf.infolist():
        total_uncompressed += zi.file_size
        if zi.compress_size > 0 and zi.file_size / max(zi.compress_size, 1) > cfg.max_decompress_ratio:
            raise IngestReject(R_ZIPBOMB, f"entry {zi.filename} ratio {zi.file_size/max(zi.compress_size,1):.0f}")
    if total_uncompressed > cfg.max_uncompressed_bytes:
        raise IngestReject(R_ZIPBOMB, f"uncompressed {total_uncompressed} > cap {cfg.max_uncompressed_bytes}")


def _bind_header(header_cells: list[Any], cfg: IngestConfig) -> dict[str, int]:
    """Map canonical name -> column index. Reject on ambiguity for money cols."""
    norm_cells = [_norm(c) for c in header_cells]
    binding: dict[str, int] = {}
    for canonical, aliases in cfg.required_columns.items():
        wanted = {_norm(canonical)} | {_norm(a) for a in aliases}
        matches = [i for i, c in enumerate(norm_cells) if c in wanted]
        if len(matches) == 1:
            binding[canonical] = matches[0]
        elif len(matches) == 0:
            if canonical in cfg.money_columns:
                raise IngestReject(R_MONEYCOL, f"required money column '{canonical}' not found")
            raise IngestReject(R_HEADER, f"required column '{canonical}' not found")
        else:
            # ambiguous: NEVER guess a money column.
            raise IngestReject(R_MONEYCOL if canonical in cfg.money_columns else R_HEADER,
                               f"column '{canonical}' ambiguous ({len(matches)} matches)")
    return binding


def _coerce_row(canonical_binding, header_cells, row_cells, cfg, sheet, source_row, src_sha) -> CanonicalRow:
    out: dict[str, Any] = {}
    for canonical, idx in canonical_binding.items():
        v = row_cells[idx] if idx < len(row_cells) else None
        if canonical in cfg.money_columns:
            out[canonical] = str(_to_decimal(v, canonical))
        elif canonical in cfg.date_columns:
            out[canonical] = _excel_serial_to_iso(v)
        else:
            out[canonical] = _neutralize_formula(str(v)) if v is not None else None
    return CanonicalRow(values=out, sheet=sheet, source_row=source_row, source_sha256=src_sha)


# ---- public entry points ---------------------------------------------------
def parse_xlsx(raw: bytes, cfg: IngestConfig) -> IngestResult:
    import openpyxl
    src_sha = hashlib.sha256(raw).hexdigest()
    _guard_xlsx_bytes(raw, cfg)
    wb = openpyxl.load_workbook(io.BytesIO(raw), read_only=True, data_only=True)  # cached values, no formulas
    if len(wb.sheetnames) > cfg.max_sheets:
        raise IngestReject(R_DIMS, f"{len(wb.sheetnames)} sheets > cap {cfg.max_sheets}")
    # choose the first sheet whose header row binds all required columns.
    last_err: IngestReject | None = None
    for sheet in wb.sheetnames:
        ws = wb[sheet]
        if ws.max_column and ws.max_column > cfg.max_cols:
            raise IngestReject(R_DIMS, f"{sheet}: {ws.max_column} cols > cap {cfg.max_cols}")
        rows_iter = ws.iter_rows(values_only=True)
        buffered = []
        header_idx = None
        binding = None
        for i, row in enumerate(rows_iter):
            if i >= cfg.header_scan_rows and header_idx is None:
                break
            buffered.append(row)
            try:
                binding = _bind_header(list(row), cfg)
                header_idx = i
                break
            except IngestReject as e:
                last_err = e
                continue
        if header_idx is None:
            continue
        # stream data rows after the header
        canonical_rows: list[CanonicalRow] = []
        n = 0
        header_cells = list(buffered[header_idx])
        for j, row in enumerate(ws.iter_rows(min_row=header_idx + 2, values_only=True)):
            if all(c is None for c in row):
                continue
            n += 1
            if n > cfg.max_rows:
                raise IngestReject(R_DIMS, f"{sheet}: > {cfg.max_rows} data rows")
            canonical_rows.append(_coerce_row(binding, header_cells, list(row), cfg, sheet, header_idx + 2 + j, src_sha))
        return IngestResult(rows=canonical_rows, sheet=sheet, header_row=header_idx,
                            source_sha256=src_sha, modality="xlsx")
    raise last_err or IngestReject(R_HEADER, "no sheet with a bindable header")


def parse_csv(raw: bytes, cfg: IngestConfig) -> IngestResult:
    if len(raw) > cfg.max_bytes:
        raise IngestReject(R_SIZE, f"{len(raw)} bytes > cap {cfg.max_bytes}")
    src_sha = hashlib.sha256(raw).hexdigest()
    text = raw.decode("utf-8-sig", errors="strict")
    reader = list(csv.reader(io.StringIO(text)))
    for i, row in enumerate(reader[: cfg.header_scan_rows]):
        try:
            binding = _bind_header(row, cfg)
        except IngestReject:
            continue
        header_cells = row
        canonical_rows = []
        for j, drow in enumerate(reader[i + 1:]):
            if not any(c.strip() for c in drow):
                continue
            if len(canonical_rows) >= cfg.max_rows:
                raise IngestReject(R_DIMS, f"> {cfg.max_rows} data rows")
            canonical_rows.append(_coerce_row(binding, header_cells, drow, cfg, "csv", i + 2 + j, src_sha))
        return IngestResult(rows=canonical_rows, sheet="csv", header_row=i,
                            source_sha256=src_sha, modality="csv")
    raise IngestReject(R_HEADER, "no bindable header row in CSV")


def parse(raw: bytes, filename: str, cfg: IngestConfig) -> IngestResult:
    """Router by extension + magic byte. Deterministic modalities only."""
    lower = filename.lower()
    if lower.endswith(".xlsm"):
        raise IngestReject(R_MACRO, "macro-enabled .xlsm not accepted")
    if lower.endswith(".xlsx"):
        return parse_xlsx(raw, cfg)
    if lower.endswith(".csv"):
        return parse_csv(raw, cfg)
    raise IngestReject(R_MAGIC, f"unsupported deterministic modality: {filename}")
