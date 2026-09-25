"""Publish human-approved chase reminders to a Delta snapshot for a SQL Alert."""

from __future__ import annotations

import argparse
from datetime import datetime, timezone

import psycopg
from databricks.sdk import WorkspaceClient
from pyspark.sql import SparkSession, types as T


SOURCE_SQL = "SELECT * FROM genie_spike.get_approved_chase_reminders(%s)"
SNAPSHOT_SCHEMA = T.StructType(
    [
        T.StructField("task_id", T.StringType(), False),
        T.StructField("task_name", T.StringType(), False),
        T.StructField("owner_email", T.StringType(), False),
        T.StructField("item_reference", T.StringType(), False),
        T.StructField("due_at", T.TimestampType(), False),
        T.StructField("offset_kind", T.StringType(), False),
        T.StructField("offset_days", T.IntegerType(), False),
        T.StructField("approved_at", T.TimestampType(), False),
        T.StructField("announcement_window", T.StringType(), False),
        T.StructField("projection_as_of", T.TimestampType(), False),
    ]
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--endpoint", required=True)
    parser.add_argument("--database", required=True)
    return parser.parse_args()


def connection_details(endpoint_name: str) -> tuple[str, str, str]:
    workspace = WorkspaceClient()
    endpoint = workspace.postgres.get_endpoint(name=endpoint_name)
    credential = workspace.postgres.generate_database_credential(endpoint=endpoint_name)
    return endpoint.status.hosts.host, workspace.current_user.me().user_name, credential.token


def read_approved(endpoint_name: str, database: str, window: str) -> list[tuple[object, ...]]:
    host, user, token = connection_details(endpoint_name)
    with psycopg.connect(host=host, dbname=database, user=user, password=token, sslmode="require") as connection:
        with connection.cursor() as cursor:
            cursor.execute(SOURCE_SQL, (window,))
            return cursor.fetchall()


def main() -> None:
    args = parse_args()
    now = datetime.now(timezone.utc)
    window = now.date().isoformat()
    rows = read_approved(args.endpoint, args.database, window)
    normalized = [
        (*row, window, now)
        for row in rows
    ]
    table_name = "`felix_demo_catalog`.`genie-automations`.`approved_chase_reminders_snapshot`"
    spark = SparkSession.builder.getOrCreate()
    frame = spark.createDataFrame(normalized, SNAPSHOT_SCHEMA)
    frame.write.format("delta").mode("overwrite").option("overwriteSchema", "true").saveAsTable(table_name)
    spark.sql(
        f"COMMENT ON TABLE {table_name} IS "
        "'Human-approved reminders announced to the native SQL Alert; announcement is not delivery confirmation'"
    )


if __name__ == "__main__":
    main()
