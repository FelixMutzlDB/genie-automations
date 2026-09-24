import ast
import pathlib
import unittest


ROOT = pathlib.Path(__file__).parents[1]
DDL = (ROOT / "sql" / "create_receivables_projection.sql").read_text()
PUBLISHER = (ROOT / "publish.py").read_text()


class ProjectionTest(unittest.TestCase):
    def test_python_is_syntactically_valid(self):
        ast.parse(PUBLISHER)

    def test_source_query_reads_only_committed_ledger_tables(self):
        self.assertIn("genie_spike.remittance", PUBLISHER)
        self.assertIn("genie_spike.allocation", PUBLISHER)
        self.assertIn("genie_spike.subsidiary_period", PUBLISHER)
        self.assertNotIn("proposed_changes", PUBLISHER)
        self.assertIn("REPEATABLE READ READ ONLY", PUBLISHER)

    def test_business_view_excludes_internal_fields(self):
        self.assertIn("`receivables_committed`", DDL)
        self.assertIn("receivables_committed_snapshot", DDL)
        for internal_name in (
            "allocation_id",
            "entity_version",
            "proposal_id",
            "payload_sha256",
            "actor_id",
        ):
            self.assertNotIn(internal_name, DDL)


if __name__ == "__main__":
    unittest.main()
