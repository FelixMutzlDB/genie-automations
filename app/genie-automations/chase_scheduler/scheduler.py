"""Scheduled chase evaluation with an intentionally non-sending transport."""

from __future__ import annotations

import argparse
import calendar
import json
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from decimal import Decimal
from typing import TYPE_CHECKING, Protocol
from zoneinfo import ZoneInfo

if TYPE_CHECKING:
    import psycopg


@dataclass(frozen=True)
class Policy:
    cadence: str
    due_offset_days: int
    default_due_at: datetime | None
    approach_offsets: tuple[int, ...]
    post_due_offsets: tuple[int, ...]
    quiet_hours_start: time
    quiet_hours_end: time
    timezone: str


class Transport(Protocol):
    """Seam for a separately approved delivery implementation."""

    def deliver(self, connection: object, task_id: str) -> None: ...


class NoOpTransport:
    """Record dry-run activity while keeping every outbox row pending."""

    def deliver(self, connection: object, task_id: str) -> None:
        connection.execute("SELECT genie_spike.mark_chase_noop(%s)", (task_id,))


def _local_datetime(day: date, at: time, timezone_name: str) -> datetime:
    return datetime.combine(day, at, ZoneInfo(timezone_name))


def shift_calendar_days(value: datetime, days: int, timezone_name: str) -> datetime:
    """Match Part A: move the local wall-clock value by calendar days, DST safely."""
    local = value.astimezone(ZoneInfo(timezone_name))
    return _local_datetime(local.date() + timedelta(days=days), local.timetz().replace(tzinfo=None), timezone_name)


def due_at_for(accounting_period: str, policy: Policy) -> datetime | None:
    try:
        if len(accounting_period) == 7:
            year, month = (int(part) for part in accounting_period.split("-"))
            base = date(year, month, calendar.monthrange(year, month)[1])
        else:
            base = date.fromisoformat(accounting_period)
    except (ValueError, TypeError):
        return policy.default_due_at
    return _local_datetime(base + timedelta(days=policy.due_offset_days), time.min, policy.timezone)


def state_at(now: datetime, due_at: datetime, approach_offsets: tuple[int, ...], timezone_name: str) -> str:
    if now >= due_at:
        return "overdue"
    boundary = shift_calendar_days(due_at, -max(approach_offsets), timezone_name)
    return "approaching_due" if now >= boundary else "scheduled"


def quiet_until(now: datetime, policy: Policy) -> datetime | None:
    local = now.astimezone(ZoneInfo(policy.timezone))
    start, end = policy.quiet_hours_start, policy.quiet_hours_end
    current = local.timetz().replace(tzinfo=None)
    if start == end:
        return None
    in_quiet = start < end and start <= current < end
    in_quiet = in_quiet or (start > end and (current >= start or current < end))
    if not in_quiet:
        return None
    end_day = local.date() + timedelta(days=1 if start > end and current >= start else 0)
    return _local_datetime(end_day, end, policy.timezone)


def due_reminders(now: datetime, due_at: datetime, policy: Policy) -> list[dict[str, object]]:
    if quiet_until(now, policy):
        return []
    reminders: list[dict[str, object]] = []
    for kind, offsets, direction in (
        ("approach", policy.approach_offsets, -1),
        ("post_due", policy.post_due_offsets, 1),
    ):
        for offset in offsets:
            checkpoint = shift_calendar_days(due_at, direction * offset, policy.timezone)
            if checkpoint <= now:
                reminders.append({"offset_kind": kind, "offset_days": offset, "checkpoint_at": checkpoint.isoformat()})
    return reminders


def next_check_at(now: datetime, due_at: datetime, policy: Policy) -> datetime | None:
    quiet_end = quiet_until(now, policy)
    if quiet_end:
        return quiet_end
    checkpoints = [
        *(shift_calendar_days(due_at, -days, policy.timezone) for days in policy.approach_offsets),
        due_at,
        *(shift_calendar_days(due_at, days, policy.timezone) for days in policy.post_due_offsets),
    ]
    future = [checkpoint for checkpoint in checkpoints if checkpoint > now]
    if not future:
        return None
    cadence = shift_calendar_days(now, 1 if policy.cadence == "daily" else 7, policy.timezone)
    return min(min(future), cadence)


def _as_datetime(value: object) -> datetime | None:
    if value is None or isinstance(value, datetime):
        return value
    return datetime.fromisoformat(str(value).replace("Z", "+00:00"))


def _policy(row: dict[str, object]) -> Policy:
    return Policy(
        cadence=str(row["cadence"]),
        due_offset_days=int(row["due_offset_days"]),
        default_due_at=_as_datetime(row["default_due_at"]),
        approach_offsets=tuple(int(value) for value in row["approach_offsets"]),
        post_due_offsets=tuple(int(value) for value in row["post_due_offsets"]),
        quiet_hours_start=row["quiet_hours_start"],
        quiet_hours_end=row["quiet_hours_end"],
        timezone=str(row["timezone"]),
    )


def evaluate_task(connection: object, task: dict[str, object], now: datetime) -> None:
    task_id = str(task["task_id"])
    policy = _policy(task)
    rows = connection.execute(
        "SELECT * FROM genie_spike.get_chase_scheduler_items(%s)", (task_id,)
    ).fetchall()
    active_references: list[str] = []
    items: list[dict[str, object]] = []
    for row in rows:
        item = dict(row)
        due_at = due_at_for(str(item["accounting_period"]), policy)
        if not due_at:
            continue
        reference = str(item["item_reference"])
        active_references.append(reference)
        next_check = next_check_at(now, due_at, policy)
        items.append(
            {
                "item_reference": reference,
                "due_at": due_at.isoformat(),
                "state": state_at(now, due_at, policy.approach_offsets, policy.timezone),
                "next_check_at": next_check.isoformat() if next_check else None,
                "outstanding_amount": str(Decimal(item["outstanding_amount"])),
                "reminders": due_reminders(now, due_at, policy),
            }
        )
    connection.execute(
        "SELECT genie_spike.apply_chase_scheduler_result(%s,%s::jsonb,%s::text[],%s)",
        (task_id, json.dumps(items), active_references, now),
    )


def run(endpoint_name: str, database: str, transport: Transport | None = None) -> None:
    import psycopg
    from databricks.sdk import WorkspaceClient

    workspace = WorkspaceClient()
    endpoint = workspace.postgres.get_endpoint(name=endpoint_name)
    credential = workspace.postgres.generate_database_credential(endpoint=endpoint_name)
    user = workspace.current_user.me().user_name
    selected_transport = transport or NoOpTransport()
    with psycopg.connect(
        host=endpoint.status.hosts.host,
        dbname=database,
        user=user,
        password=credential.token,
        sslmode="require",
        row_factory=psycopg.rows.dict_row,
    ) as connection:
        tasks = connection.execute("SELECT * FROM genie_spike.get_chase_scheduler_tasks()").fetchall()
        connection.commit()
        for task in tasks:
            task_id = str(task["task_id"])
            try:
                with connection.transaction():
                    evaluate_task(connection, dict(task), datetime.now(timezone.utc))
                    selected_transport.deliver(connection, task_id)
            except Exception as error:
                connection.rollback()
                with connection.transaction():
                    connection.execute(
                        "SELECT genie_spike.log_chase_scheduler_failure(%s,%s)",
                        (task_id, type(error).__name__),
                    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--endpoint", required=True)
    parser.add_argument("--database", required=True)
    args = parser.parse_args()
    run(args.endpoint, args.database)


if __name__ == "__main__":
    main()
