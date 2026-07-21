import pytest
from pydantic import ValidationError

from models import Holding


def test_holding_normalizes_ticker_case_and_whitespace():
    holding = Holding(ticker=" aapl ", quantity=1, avg_cost=1)
    assert holding.ticker == "AAPL"


@pytest.mark.parametrize(
    "ticker",
    [
        "TOOLONG",  # more than 5 letters
        "12AB",  # digits aren't allowed
        "",  # empty
        "AA-PL",  # punctuation isn't allowed
    ],
)
def test_holding_rejects_invalid_ticker(ticker):
    with pytest.raises(ValidationError):
        Holding(ticker=ticker, quantity=1, avg_cost=1)


@pytest.mark.parametrize("field", ["quantity", "avg_cost"])
def test_holding_rejects_non_positive_numbers(field):
    kwargs = {"ticker": "AAPL", "quantity": 1, "avg_cost": 1, field: 0}
    with pytest.raises(ValidationError):
        Holding(**kwargs)
