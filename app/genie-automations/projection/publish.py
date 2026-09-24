"""Publish business-safe committed Lakebase receivables to a Delta snapshot."""

from __future__ import annotations

import argparse
from decimal import Decimal

import psycopg
from databricks.sdk import WorkspaceClient
from pyspark.sql import SparkSession, types as T


SOURCE_SQL = """
SELECT
  r.remittance_id AS remittance_reference,
  r.subsidiary_id AS subsidiary,
  r.period AS accounting_period,
  r.total_amount AS remittance_amount,
  a.invoice_id AS invoice_reference,
  a.amount AS allocated_amount,
  COALESCE(SUM(a.amount) OVER (PARTITION BY r.remittance_id), 0) AS total_allocated_amount,
  r.total_amount - COALESCE(SUM(a.amount) OVER (PARTITION BY r.remittance_id), 0) AS remaining_amount,
  CASE
    WHEN COALESCE(SUM(a.amount) OVER (PARTITION BY r.remittance_id), 0) > r.total_amount
      THEN 'over_allocated'
    WHEN COALESCE(SUM(a.amount) OVER (PARTITION BY r.remittance_id), 0) = r.total_amount
      THEN 'fully_allocated'
    WHEN COALESCE(SUM(a.amount) OVER (PARTITION BY r.remittance_id), 0) = 0
      THEN 'unallocated'
    ELSE 'partially_allocated'
  END AS allocation_status,
  p.status AS period_status,
  transaction_timestamp() AS projection_as_of
FROM genie_spike.remittance r
LEFT JOIN genie_spike.allocation a USING (remittance_id)
LEFT JOIN genie_spike.subsidiary_period p
  ON r.subsidiary_id = p.subsidiary_id AND r.period = p.period
ORDER BY r.remittance_id, a.invoice_id
"""

SNAPSHOT_SCHEMA = T.StructType(
    [
        T.StructField("remittance_reference", T.StringType(), False),
        T.StructField("subsidiary", T.StringType(), False),
        T.StructField("accounting_period", T.StringType(), False),
        T.StructField("remittance_amount", T.DecimalType(18, 2), False),
        T.StructField("invoice_reference", T.StringType(), True),
        T.StructField("allocated_amount", T.DecimalType(18, 2), True),
        T.StructField("total_allocated_amount", T.DecimalType(18, 2), False),
        T.StructField("remaining_amount", T.DecimalType(18, 2), False),
        T.StructField("allocation_status", T.StringType(), False),
        T.StructField("period_status", T.StringType(), True),
        T.StructField("projection_as_of", T.TimestampType(), False),
    ]
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--endpoint", required=True)
    parser.add_argument("--database", required=True)
    return parser.parse_args()


def read_snapshot(endpoint_name: str, database: str) -> list[tuple[object, ...]]:
    workspace = WorkspaceClient()
    endpoint = workspace.postgres.get_endpoint(name=endpoint_name)
    credential = workspace.postgres.generate_database_credential(endpoint=endpoint_name)
    user = workspace.current_user.me().user_name

    with psycopg.connect(
        host=endpoint.status.hosts.host,
        dbname=database,
        user=user,
        password=credential.token,
        sslmode="require",
    ) as connection:
        connection.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        with connection.cursor() as cursor:
            cursor.execute(SOURCE_SQL)
            return cursor.fetchall()


def main() -> None:
    args = parse_args()
    rows = read_snapshot(args.endpoint, args.database)
    if not rows:
        raise RuntimeError("Lakebase returned no remittances; refusing to erase the last good snapshot")

    normalized = [
        tuple(
            Decimal(value) if index in {3, 5, 6, 7} and value is not None else value
            for index, value in enumerate(row)
        )
        for row in rows
    ]
    table_name = "`felix_demo_catalog`.`genie-automations`.`receivables_committed_snapshot`"
    spark = SparkSession.builder.getOrCreate()
    frame = spark.createDataFrame(normalized, SNAPSHOT_SCHEMA)
    (
        frame.write.format("delta")
        .mode("overwrite")
        .option("overwriteSchema", "true")
        .saveAsTable(table_name)
    )
    spark.sql(
        f"COMMENT ON TABLE {table_name} IS "
        "'Business-safe snapshot of committed Lakebase receivables; maintained by the projection job'"
    )
    spark.sql(
        f"ALTER TABLE {table_name} SET TBLPROPERTIES ("
        "'delta.enableChangeDataFeed' = 'false', "
        "'projection.owner' = 'genie-automations')"
    )


if __name__ == "__main__":
    main()
