import pathlib
import sys
import unittest
from datetime import datetime, time, timedelta, timezone

sys.path.insert(0, str(pathlib.Path(__file__).parents[1]))
from scheduler import Policy, due_at_for, due_reminders, next_check_at, quiet_until, state_at  # noqa: E402


POLICY = Policy(
    cadence="daily",
    due_offset_days=2,
    default_due_at=None,
    approach_offsets=(7, 2),
    post_due_offsets=(1, 7, 14),
    quiet_hours_start=time(18),
    quiet_hours_end=time(8),
    timezone="Europe/Berlin",
)


class SchedulerRulesTest(unittest.TestCase):
    def test_matches_part_a_due_date_and_dst_boundaries(self):
        self.assertEqual(
            "2026-10-01T22:00:00+00:00", due_at_for("2026-09", POLICY).astimezone(timezone.utc).isoformat()
        )
        due = datetime.fromisoformat("2026-03-31T22:00:00+00:00")
        boundary = datetime.fromisoformat("2026-03-28T23:00:00+00:00")
        self.assertEqual("scheduled", state_at(boundary - timedelta(microseconds=1), due, (3,), POLICY.timezone))
        self.assertEqual("approaching_due", state_at(boundary, due, (3,), POLICY.timezone))

    def test_fires_each_crossed_offset_once_via_stable_offset_keys(self):
        due = datetime.fromisoformat("2026-10-10T00:00:00+00:00")
        reminders = due_reminders(datetime.fromisoformat("2026-10-18T12:00:00+00:00"), due, POLICY)
        self.assertEqual(
            [("approach", 7), ("approach", 2), ("post_due", 1), ("post_due", 7)],
            [(item["offset_kind"], item["offset_days"]) for item in reminders],
        )

    def test_quiet_hours_defer_to_local_end_without_creating_reminders(self):
        now = datetime.fromisoformat("2026-10-08T20:00:00+00:00")
        due = datetime.fromisoformat("2026-10-10T00:00:00+00:00")
        self.assertEqual("2026-10-09T08:00:00+02:00", quiet_until(now, POLICY).isoformat())
        self.assertEqual([], due_reminders(now, due, POLICY))
        self.assertEqual(quiet_until(now, POLICY), next_check_at(now, due, POLICY))


if __name__ == "__main__":
    unittest.main()
