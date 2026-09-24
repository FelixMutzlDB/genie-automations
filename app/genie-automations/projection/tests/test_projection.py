import ast
import pathlib
import re
import unittest


ROOT = pathlib.Path(__file__).parents[1]
APP_ROOT = ROOT.parent
DDL = (ROOT / "sql" / "create_receivables_projection.sql").read_text()
PUBLISHER = (ROOT / "publish.py").read_text()
BUNDLE = (APP_ROOT / "databricks.yml").read_text()
TREE = ast.parse(PUBLISHER)
SOURCE_SQL = next(
    ast.literal_eval(node.value)
    for node in TREE.body
    if isinstance(node, ast.Assign)
    and any(isinstance(target, ast.Name) and target.id == "SOURCE_SQL" for target in node.targets)
)

PUBLISHED_COLUMNS = (
    "remittance_reference",
    "accounting_period",
    "remittance_amount",
    "invoice_reference",
    "allocated_amount",
    "total_allocated_amount",
    "remaining_amount",
    "allocation_status",
    "period_status",
    "projection_as_of",
)


def top_level_select_expressions(sql: str) -> list[str]:
    select_list = sql.split("SELECT", 1)[1].split("FROM genie_spike.remittance", 1)[0]
    expressions: list[str] = []
    start = 0
    depth = 0
    quote: str | None = None
    index = 0
    while index < len(select_list):
        char = select_list[index]
        if quote:
            if char == quote:
                if index + 1 < len(select_list) and select_list[index + 1] == quote:
                    index += 1
                else:
                    quote = None
        elif char in {"'", '"'}:
            quote = char
        elif char == "(":
            depth += 1
        elif char == ")":
            depth -= 1
        elif char == "," and depth == 0:
            expressions.append(select_list[start:index].strip())
            start = index + 1
        index += 1
    expressions.append(select_list[start:].strip())
    return expressions


class ProjectionTest(unittest.TestCase):
    def test_python_is_syntactically_valid(self):
        ast.parse(PUBLISHER)

    def test_source_select_list_matches_explicit_allowlist(self):
        aliases = []
        for expression in top_level_select_expressions(SOURCE_SQL):
            matches = re.findall(r"\bAS\s+([a-z_][a-z0-9_]*)", expression, re.IGNORECASE)
            self.assertEqual(1, len(matches), f"expression must have exactly one alias: {expression}")
            self.assertRegex(
                expression,
                rf"\bAS\s+{re.escape(matches[0])}\s*$",
                f"alias must terminate expression: {expression}",
            )
            aliases.append(matches[0].lower())
        self.assertEqual(PUBLISHED_COLUMNS, tuple(aliases))

    def test_view_matches_explicit_allowlist(self):
        view_select = DDL.split("\nSELECT\n", 1)[1].split("\nFROM ", 1)[0]
        selected = tuple(name.strip() for name in view_select.split(","))
        self.assertEqual(PUBLISHED_COLUMNS, selected)

    def test_source_is_read_only_and_does_not_call_guarded_procs(self):
        forbidden = (
            r"\bINSERT\b",
            r"\bUPDATE\b",
            r"\bDELETE\b",
            r"\bMERGE\b",
            r"\bstage_change\s*\(",
            r"\bapprove_change\s*\(",
            r"\bcommit_change\s*\(",
        )
        for pattern in forbidden:
            with self.subTest(pattern=pattern):
                self.assertIsNone(re.search(pattern, SOURCE_SQL, re.IGNORECASE))
        self.assertIn("REPEATABLE READ READ ONLY", PUBLISHER)

    def test_source_query_reads_only_committed_ledger_tables(self):
        self.assertIn("genie_spike.remittance", SOURCE_SQL)
        self.assertIn("genie_spike.allocation", SOURCE_SQL)
        self.assertIn("genie_spike.subsidiary_period", SOURCE_SQL)
        self.assertNotIn("proposed_changes", SOURCE_SQL)

    def test_job_runs_as_required_dedicated_publisher(self):
        self.assertRegex(BUNDLE, r"projection_publisher_sp:\n\s+description:")
        publisher_block = BUNDLE.split("projection_publisher_sp:", 1)[1].split("resources:", 1)[0]
        self.assertNotIn("default:", publisher_block)
        self.assertIn("service_principal_name: ${var.projection_publisher_sp}", BUNDLE)


if __name__ == "__main__":
    unittest.main()
