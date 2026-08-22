# timezone_utils.py — Pakistan Standard Time helpers
#
# The app stores `created_at` as plain ISO-format strings (VARCHAR columns,
# not real TIMESTAMP columns), so timestamps must stay naive (no timezone
# suffix) to keep string comparisons/sorting working exactly as before.
# Instead of switching to full timezone-aware datetimes (which would add
# a "+05:00" suffix and break existing string-based comparisons), these
# helpers just shift the wall-clock value by Pakistan's fixed UTC+5 offset
# before formatting — same string format as before, correct local time.

from datetime import datetime, timedelta

PK_OFFSET = timedelta(hours=5)


def now_pk():
    """Naive datetime representing the current moment in Pakistan time."""
    return datetime.utcnow() + PK_OFFSET


def today_pk():
    """Naive date representing today's date in Pakistan time."""
    return now_pk().date()