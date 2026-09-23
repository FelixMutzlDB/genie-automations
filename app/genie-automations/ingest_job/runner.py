#!/usr/bin/env python3
"""Preview-only Databricks Job wrapper around the unchanged deterministic parser."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
from dataclasses import asdict

from parser.parse import IngestConfig, IngestReject, parse


CONFIG = IngestConfig(
    required_columns={
        "remittance_id": ["remittance", "remittance id"],
        "invoice_id": ["invoice", "invoice no", "invoice id"],
        "amount": ["amt", "betrag", "total", "payment amount"],
        "pay_date": ["date", "payment date", "pay date"],
    },
    money_columns={"amount"},
    key_columns={"remittance_id", "invoice_id"},
    date_columns={"pay_date"},
)


def arguments() -> argparse.Namespace:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--artifact", required=True)
    ap.add_argument("--sha256", required=True)
    ap.add_argument("--parse-id", required=True)
    ap.add_argument("--filename", required=True)
    return ap.parse_args()


def source_row(message: str) -> int | None:
    match = re.search(r"\brow (\d+)\b", message)
    return int(match.group(1)) if match else None


def main() -> None:
    args = arguments()
    with open(args.input, "rb") as handle:
        raw = handle.read()
    actual_sha = hashlib.sha256(raw).hexdigest()
    if actual_sha != args.sha256:
        raise RuntimeError("IG016: uploaded bytes no longer match their SHA-256")

    artifact: dict[str, object] = {
        "parse_id": args.parse_id,
        "sha256": actual_sha,
        "parser_version": "spike-02-v2",
        "config_version": "receivables-v1",
        "rows": [],
        "rejected_rows": [],
        "warnings": [],
    }
    try:
        result = parse(raw, args.filename, CONFIG)
        artifact.update({
            "status": "ready",
            "rows": [asdict(row) for row in result.rows],
            "warnings": ([f"Skipped {result.skipped_summary} summary row(s)."] if result.skipped_summary else []),
            "sheet": result.sheet,
            "header_row": result.header_row,
            "modality": result.modality,
        })
    except IngestReject as exc:
        message = str(exc).split(": ", 1)[-1]
        artifact.update({
            "status": "rejected",
            "rejected_rows": [{"code": exc.code, "guidance": message, "source_row": source_row(message)}],
        })

    os.makedirs(os.path.dirname(args.artifact), exist_ok=True)
    temporary = f"{args.artifact}.tmp-{args.parse_id}"
    with open(temporary, "w", encoding="utf-8") as handle:
        json.dump(artifact, handle, sort_keys=True, separators=(",", ":"))
    os.replace(temporary, args.artifact)


if __name__ == "__main__":
    main()
