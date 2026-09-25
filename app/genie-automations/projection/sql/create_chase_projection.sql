-- Databricks notebook source
CREATE OR REPLACE VIEW `felix_demo_catalog`.`genie-automations`.`approved_chase_reminders`
COMMENT 'Human-approved reminders announced to the DBSQL digest. Announced does not mean email delivery was confirmed.'
AS
SELECT
  task_id,
  task_name,
  owner_email,
  item_reference,
  due_at,
  offset_kind,
  offset_days,
  approved_at
FROM `felix_demo_catalog`.`genie-automations`.`approved_chase_reminders_snapshot`
WHERE announcement_window = CAST(current_date() AS STRING);

ALTER VIEW `felix_demo_catalog`.`genie-automations`.`approved_chase_reminders`
SET TAGS ('data_classification' = 'u-nnpi', 'projection_mode' = 'approved_digest');
