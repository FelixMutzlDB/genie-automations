-- Automation #2 — Vendor bank-detail change governance (framework-thesis test).
--
-- This is a MATERIALLY DIFFERENT automation TYPE from receivables reconciliation:
--   • records: independent per-record changes (NOT aggregate line-items)
--   • aggregate invariant: NONE (reconciliation has the over-allocation ceiling)
--   • validation: algorithmic + referential (IBAN MOD-97, BIC format, vendor
--     exists, IBAN-not-already-assigned) — NOT arithmetic-aggregate
--   • schedule: event-driven / one-off (reconciliation is periodic cutoff)
--   • SoD: an INTRINSIC fraud control (bank-detail change is the classic BEC
--     vector; dual-control is a legal/audit requirement, not platform hygiene)
--
-- What this file adds is ADDITIVE CAPABILITY referenced from config:
--   - two new destination tables (vendor_master reference + effective-dated
--     vendor_bank_detail master)
--   - a deterministic IBAN validator function (iban_is_valid)
-- The commit ENGINE's shared control flow is unchanged; the vendor write logic
-- is an additive dispatched handler (see 02_commit_change.sql). See the change
-- log in docs/plan/13-automation2-changelog.md for the honest config/capability/
-- engine classification.

SET search_path TO genie_spike;

-- ---------------------------------------------------------------------------
-- Reference data: the vendor master (for the referential "vendor exists" check).
-- The vendor row also serves as the per-vendor CONCURRENCY root (FOR UPDATE) —
-- note this is a *reference* root for serialization, NOT an aggregate-invariant
-- root. There is no cross-record sum to protect (unlike remittance).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS vendor_master (
    vendor_id    TEXT PRIMARY KEY,
    legal_name   TEXT NOT NULL,
    active       BOOLEAN NOT NULL DEFAULT TRUE
);

-- Effective-dated bank-detail master. A new approved change SUPERSEDES the prior
-- current row (SCD-2-style): mark the old row is_current=false, insert a new
-- is_current=true row. Two partial-unique indexes enforce the invariants at the
-- DB level as defense-in-depth behind the explicit GA0xx checks in the handler.
CREATE TABLE IF NOT EXISTS vendor_bank_detail (
    vbd_id          BIGSERIAL PRIMARY KEY,
    vendor_id       TEXT NOT NULL REFERENCES vendor_master(vendor_id),
    iban            TEXT NOT NULL,
    bic             TEXT NOT NULL,
    effective_date  DATE NOT NULL,
    entity_version  BIGINT NOT NULL DEFAULT 0,
    is_current      BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- At most one CURRENT bank-detail per vendor:
CREATE UNIQUE INDEX IF NOT EXISTS ux_vbd_current_vendor
    ON vendor_bank_detail(vendor_id) WHERE is_current;
-- An IBAN may be CURRENT for at most one vendor (fraud/uniqueness invariant):
CREATE UNIQUE INDEX IF NOT EXISTS ux_vbd_current_iban
    ON vendor_bank_detail(iban) WHERE is_current;

-- ---------------------------------------------------------------------------
-- Deterministic IBAN validator — ISO 7064 MOD-97-10. Additive capability that
-- validation_rules can reference by name (config -> named function). No LLM, no
-- arithmetic aggregate: a genuinely different validation SHAPE from GA005.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION iban_is_valid(p_iban TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
    s           TEXT;
    rearranged  TEXT;
    numeric_str TEXT := '';
    ch          TEXT;
    i           INT;
    remainder   INT := 0;
BEGIN
    IF p_iban IS NULL THEN RETURN FALSE; END IF;
    s := upper(regexp_replace(p_iban, '\s', '', 'g'));
    -- basic structural gate: 2 letters (country) + 2 digits (check) + BBAN
    IF s !~ '^[A-Z]{2}[0-9]{2}[A-Z0-9]+$' OR length(s) < 15 OR length(s) > 34 THEN
        RETURN FALSE;
    END IF;
    rearranged := substr(s, 5) || substr(s, 1, 4);   -- move first 4 chars to end
    FOR i IN 1..length(rearranged) LOOP
        ch := substr(rearranged, i, 1);
        IF ch ~ '[0-9]' THEN
            numeric_str := numeric_str || ch;
        ELSE
            numeric_str := numeric_str || (ascii(ch) - ascii('A') + 10)::TEXT;  -- A=10 .. Z=35
        END IF;
    END LOOP;
    -- piecewise mod-97 over the long numeric string (avoids bigint overflow)
    FOR i IN 1..length(numeric_str) LOOP
        remainder := (remainder * 10 + substr(numeric_str, i, 1)::INT) % 97;
    END LOOP;
    RETURN remainder = 1;
END;
$$;

-- ---------------------------------------------------------------------------
-- Seed synthetic vendors + one existing current bank detail (for the UPDATE /
-- version-check + collision tests). No PII; synthetic names only.
-- ---------------------------------------------------------------------------
INSERT INTO vendor_master(vendor_id, legal_name, active) VALUES
    ('VEND-1001', 'Aurora Components GmbH', TRUE),
    ('VEND-1002', 'Borealis Fasteners AB',  TRUE),
    ('VEND-1003', 'Caldera Hydraulics SpA',  TRUE),
    ('VEND-1009', 'Dormant Supplies Ltd',    FALSE)
ON CONFLICT (vendor_id) DO NOTHING;

-- VEND-1001 already has a current IBAN on file (valid DE IBAN). Used to test the
-- effective-dated UPDATE path (mandatory expected_version) and the IBAN-collision
-- guard (trying to assign this same IBAN to VEND-1002 must fail GA013).
INSERT INTO vendor_bank_detail(vendor_id, iban, bic, effective_date, entity_version, is_current)
SELECT 'VEND-1001', 'DE89370400440532013000', 'COBADEFFXXX', DATE '2026-01-01', 1, TRUE
WHERE NOT EXISTS (SELECT 1 FROM vendor_bank_detail WHERE vendor_id = 'VEND-1001' AND is_current);
