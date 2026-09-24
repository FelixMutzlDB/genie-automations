-- Databricks notebook source
-- Consumers receive SELECT on this view only. The publisher owns the snapshot.

CREATE OR REPLACE VIEW `felix_demo_catalog`.`genie-automations`.`receivables_committed`
COMMENT 'Committed receivables and allocation state copied from Lakebase. One row per allocation, or one row with no invoice for an unallocated remittance.'
AS
SELECT
  remittance_reference,
  accounting_period,
  remittance_amount,
  invoice_reference,
  allocated_amount,
  total_allocated_amount,
  remaining_amount,
  allocation_status,
  period_status,
  projection_as_of
FROM `felix_demo_catalog`.`genie-automations`.`receivables_committed_snapshot`;

ALTER VIEW `felix_demo_catalog`.`genie-automations`.`receivables_committed`
SET TAGS ('data_classification' = 'internal', 'projection_mode' = 'scheduled_snapshot');
