# Lakebase → Delta receivables projection

`felix_demo_catalog`.`genie-automations`.`receivables_committed` is the only
object intended for Genie and business-user access. It exposes the current
committed remittance/allocation ledger with business names, allocation status,
and an as-of timestamp. It excludes proposal payloads, actor identities,
versions, hashes, and internal allocation identifiers.

## Design and freshness

The bundle job opens a read-only, repeatable-read transaction against
`genie_spike.remittance`, `allocation`, and `subsidiary_period`, then atomically
overwrites the managed Delta table `receivables_committed_snapshot`. A SQL task
creates the read-only `receivables_committed` view over that snapshot.

The source tables are the transactional result of `commit_change`; staged
proposal rows are never queried. `projection_as_of` is the Lakebase transaction
timestamp shared by every row in one consistent snapshot.

The job is provisioned paused for a deliberate first run, then should run every
five minutes. Expected lag is 0–5 minutes plus job duration. A failed or empty
read does not erase the last good Delta version. Delta overwrite commits are
atomic, so Genie sees either the prior complete snapshot or the new one.

Native Lakehouse Sync was rejected for this schema: it operates at schema scope,
would replicate proposal/audit/config tables, requires full replica identity on
all source tables, and `genie_spike` contains unsupported `uuid` columns. The
scheduled projection is narrower and avoids exposing those objects.

## Activation (not performed by this PR)

1. Choose a dedicated publisher service principal. Grant it `CAN CONNECT` on
   project `genie-automations` / branch `production`, PostgreSQL `USAGE` on
   schema `genie_spike`, and `SELECT` on only `remittance`, `allocation`, and
   `subsidiary_period`. Grant its workspace identity `USE CATALOG`, `USE SCHEMA`,
   `CREATE TABLE`, and `MODIFY` in `felix_demo_catalog.genie-automations`.
2. Configure the bundle job to run as that publisher. Deploy and perform the
   first run explicitly:

   ```bash
   databricks bundle deploy -t default --profile fevm-felix-demo
   databricks bundle run publish_receivables_projection -t default \
     --profile fevm-felix-demo
   ```

3. Verify row count, `projection_as_of`, balances, and that the job succeeded.
   Then unpause its five-minute schedule.
4. Grant only the curated view. Replace principals with the deployed app service
   principal client ID and approved business group:

   ```sql
   GRANT USE CATALOG ON CATALOG `felix_demo_catalog` TO `<app-sp-client-id>`;
   GRANT USE SCHEMA ON SCHEMA `felix_demo_catalog`.`genie-automations` TO `<app-sp-client-id>`;
   GRANT SELECT ON VIEW `felix_demo_catalog`.`genie-automations`.`receivables_committed` TO `<app-sp-client-id>`;
   GRANT USE CATALOG ON CATALOG `felix_demo_catalog` TO `<business-group>`;
   GRANT USE SCHEMA ON SCHEMA `felix_demo_catalog`.`genie-automations` TO `<business-group>`;
   GRANT SELECT ON VIEW `felix_demo_catalog`.`genie-automations`.`receivables_committed` TO `<business-group>`;
   ```

   Grant both consumer principals `CAN USE` on warehouse `f7cdb11888c4799e`
   (Serverless Starter Warehouse). Do not grant them `SELECT` or `MODIFY` on
   `receivables_committed_snapshot`.

5. Add only `felix_demo_catalog.genie-automations.receivables_committed` to the
   focused Genie Space source set. Profile real values before adding examples or
   entity matching.

## Operations and rollback

Alert on failed runs and on `projection_as_of` older than ten minutes while the
source is expected to change. Delta time travel preserves prior versions of the
snapshot. Pausing the job leaves the last good snapshot available; dropping the
view does not affect Lakebase.
