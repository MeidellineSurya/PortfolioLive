import pytest

from alert_service import AlertService


@pytest.mark.parametrize(
    "previous_price,price,target,expected",
    [
        (199, 200, 200, "above"),  # lands exactly on target from below
        (199, 202, 200, "above"),  # jumps clean over the target
        (202, 200, 200, "below"),  # lands exactly on target from above
        (202, 198, 200, "below"),  # jumps clean under the target
        (201, 202, 200, None),  # already past target, moving further away
        (198, 199, 200, None),  # still below target, hasn't reached it
        (200, 200, 200, None),  # no movement
    ],
)
def test_crossed(previous_price, price, target, expected):
    assert AlertService._crossed(previous_price, price, target) == expected
