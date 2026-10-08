import json
from pathlib import Path

import pytest

from displayxr_gadget.protocol import parse_line, validate

CASES = json.loads(
    (Path(__file__).resolve().parents[2] / "test-fixtures" / "protocol-cases.json").read_text(encoding="utf-8")
)


@pytest.mark.parametrize("case", CASES["validate"], ids=lambda c: f"{c['cmd']}-{json.dumps(c['args'])}")
def test_validate_matches_shared_cases(case):
    got = validate(case["cmd"], case["args"])
    if case["error"] is None:
        assert got is None
    else:
        assert got is not None and case["error"] in got


@pytest.mark.parametrize("case", CASES["parse"], ids=lambda c: c["line"].strip())
def test_parse_line_matches_shared_cases(case):
    assert parse_line(case["line"]) == (case["cmd"], case["args"])


def test_validate_without_args():
    assert validate("clear") is None
