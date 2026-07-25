import pytest
from pydantic import ValidationError

from models import Holding, currency_for_ticker


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
        "TOOLONG.JK",  # root still can't exceed 5 letters with the suffix
        "AAPL.NY",  # only .JK is a recognized exchange suffix
    ],
)
def test_holding_rejects_invalid_ticker(ticker):
    with pytest.raises(ValidationError):
        Holding(ticker=ticker, quantity=1, avg_cost=1)


def test_holding_accepts_a_jk_suffixed_indonesia_ticker():
    holding = Holding(ticker=" bbca.jk ", quantity=10, avg_cost=6000)
    assert holding.ticker == "BBCA.JK"


@pytest.mark.parametrize(
    "ticker,expected",
    [
        ("AAPL", "USD"),
        ("BBCA.JK", "IDR"),
        ("TLKM.JK", "IDR"),
    ],
)
def test_currency_for_ticker(ticker, expected):
    assert currency_for_ticker(ticker) == expected


@pytest.mark.parametrize("field", ["quantity", "avg_cost"])
def test_holding_rejects_non_positive_numbers(field):
    kwargs = {"ticker": "AAPL", "quantity": 1, "avg_cost": 1, field: 0}
    with pytest.raises(ValidationError):
        Holding(**kwargs)
