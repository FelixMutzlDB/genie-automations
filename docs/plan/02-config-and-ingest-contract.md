# 02 — Config-Governance + Ingest-Router Contract

Owner: write-path engine. QC fixes marked `[fix]`.

## 1. `genie_automations_config` schema

| Table | Key fields | Class |
|---|---|---|
| `task_registry` | `task_id`, `task_type`, `owner`, `active_version_hash` | mixed |
| `destination_binding` | `task_id`, `dest_catalog/schema/table`, `write_scope`, `identity_ref` | **admin registry (security)** |
| `validation_rules` | `task_id`, `rule_id`, `expr_ref`, `level(block/warn)`, `severity` | user + platform-min |
| `header_aliases` | `task_id`, `canonical_field`, `alias`, `match_mode(exact/ci)` | user |
| `chase_policy` | `task_id`, `channels`, `suppression`, `quiet_hours`, `rate_limit`, `recipient_source` | user; **recipient registry = admin** |
| `config_version` | `task_id`, `version_hash`, `payload`, `status(draft/published/retired)`, `effective_from`, `approved_by[2]` | immutable when published |

## 2. User-editable vs admin security bindings

- **User-editable:** validation thresholds (within platform minimums), aliases,
  tone, schedule, chase cadence.
- **Admin registry only (2-person dual-control):** destination target/schema,
  write scope, execution identity, recipient registry, ABAC scope. This is the
  confused-deputy firewall (C-01/C-08).

## 3. Version immutability + platform minimums

- Published `config_version` is **immutable, content-addressed by hash**; the
  same hash is pinned through ingest → validate → approve → commit (C-09/C-10).
- **`[fix]` Retirement, not silent supersession**, is what invalidates in-flight
  proposals (see doc 01 §1). Publishing a newer version does not auto-expire
  proposals pinned to the prior version.
- **Platform-minimum validations config CANNOT disable:** money-column
  presence + type, cross-foot totals, non-negative allocations, over-allocation
  ceiling, structural-confidence floor. `validation_rules` may only *add* or
  *tighten*.

## 4. Caller authorization contract

- Caller (agent/UI) passes **`task_id` + `config_version_hash` + run params
  only** — never target names or validation expressions (C-01/C-08).
- Endpoint resolves the spec **server-side** from the registry; verifies
  destination ∈ **allowlist**; **re-checks ABAC as the acting user (OBO)**.
- Agent may only pass `task_id`s in the acting user's grant set.
- **Who edits/activates:** owners edit user settings; admins (2-person) edit
  registry bindings and publish/retire versions.
- **`[fix]` ABAC → Lakebase is not automatic.** Unity Catalog ABAC governs UC
  objects (Volumes, Delta), **not** Postgres rows. "Re-check ABAC as acting
  user" must be translated into a concrete Lakebase mechanism: either
  **per-target proc grants / row-security policies** in Postgres, or a
  **trusted, server-attested authorization input** (the endpoint resolves the
  user's entitlements and passes an attested scope the proc enforces). UC
  destination checks alone do **not** protect the Postgres target — this is a
  Spike-1 item to pin down.

## 5. Ingest router

| Modality | Extractor | Det/Prob | Where |
|---|---|---|---|
| xlsx (HARD) | openpyxl/pandas deterministic | Deterministic | endpoint (small) / **Job** (bulk/heavy) |
| csv | deterministic delimited parse | Deterministic | endpoint / Job |
| image/screenshot | vision FM (interactive) / `ai_parse_document` (bulk Job) | **Probabilistic — always gated + human-confirm `[fix]`** | vision FM in-endpoint / Job |
| chat text | delimited-first, else gated LLM | **Probabilistic values always gated + human-confirm `[fix]`** | endpoint |

- **All modalities Volume-land raw bytes + SHA-256 first** (untrusted sandbox).
- **`[fix]` Confidence-gating and human-confirmation for the probabilistic
  path (image + freeform chat extraction) are ALWAYS required — regardless of
  aggregate benchmark accuracy.** The Spike-2 accuracy bar governs whether the
  *deterministic* path may auto-commit; it does **not** license
  auto-committing probabilistic extractions.

### xlsx edge-case register (deterministic path)
- sheet selection by name (multi-sheet)
- **use cached values, never evaluate formulas** (formula string retained only as evidence)
- merged-header detection with confidence → **reject on ambiguity** → human-confirm (C-17)
- hidden rows/cols surfaced, not silently dropped
- Excel **date serial** → ISO
- **locale number** parsing (`1.234,56`)
- workbook size / row / col caps + **decompression-ratio limit** (zip-bomb, C-16)
- **reject macros (`.xlsm`) + encrypted** workbooks
- **magic-byte content-type check** (not extension)
- partial-row errors quarantined per-row (a bad row does not fail the whole file, but see doc 01 §1 — quarantined rows form a new proposal)

### Alias-poisoning defense (C-15)
Money columns bind to **strict canonical names, not fuzzy aliases**;
multi-match / ambiguous header → **reject, never guess**; alias set is
versioned/approved; mapping logged per run.

### Formula neutralization (C-18)
Any text cell rendered to a human is prefixed-neutralized (`'` before a leading
`= + - @`) before display/export.

### Typed injection boundary (C-12/13/14)
The agent sees **enumerated field IDs + typed values + confidence codes only** —
never raw headers, filenames, OCR text, or formulas. Free-text values are
excluded from the agent's *decision* context; if surfaced, they are
hard-delimited as untrusted data with no authority.
