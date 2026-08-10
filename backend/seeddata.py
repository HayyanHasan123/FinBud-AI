# seed_data.py — FinBud AI
# ─────────────────────────────────────────────────────────────────────────────
# Inserts 4 months of realistic MOCK data (income, expenses, bills) for a
# given account, so the Financial Advisor panel (income vs expense, monthly
# trend, spending breakdown, credit score) has enough history to actually
# show something in a demo — without touching whatever REAL activity that
# account has done in the current month.
#
# The mock window is always "the 4 calendar months before the current one" —
# NOT hardcoded to March–June. Run this today (July) and it fills in
# March–June; run it in October and it fills in June–September. The current
# month is always left alone, so real testing/demo activity from this month
# stays exactly as-is.
#
# SAFE TO RUN MULTIPLE TIMES for the same account — before inserting, it
# deletes any previously-seeded rows that fall inside that same 4-month
# window (and ONLY that window), so re-running just refreshes the mock data
# instead of duplicating it. It never touches rows dated in the current
# month, so real activity is never at risk.
#
# Every account gets the exact same mock content (same categories, same
# amounts, same days-of-month) — only the account_number differs — so
# results look consistent across everyone testing the app.
#
# Does NOT touch dashboard_users.balance/points or the rewards table, since
# those should reflect each account's real, current activity, not mock data.
#
# USAGE:
#   1. Make sure your .env file has DATABASE_URL set correctly.
#   2. Run:  python seed_data.py <account_number>
#      e.g.: python seed_data.py ACC20260622123456
# ─────────────────────────────────────────────────────────────────────────────

import os
import sys
import psycopg2
import psycopg2.extras
from datetime import datetime
from dotenv import load_dotenv

load_dotenv()

DATABASE_URL = os.getenv("DATABASE_URL")
if not DATABASE_URL:
    sys.exit("❌  DATABASE_URL not set in .env")

if len(sys.argv) < 2:
    sys.exit("❌  Usage: python seed_data.py <account_number>")

ACCOUNT = sys.argv[1]

conn = psycopg2.connect(DATABASE_URL)
conn.cursor_factory = psycopg2.extras.RealDictCursor
c = conn.cursor()

# ── Verify account exists ─────────────────────────────────────────────────────
c.execute("SELECT id FROM dashboard_users WHERE account_number=%s", (ACCOUNT,))
if not c.fetchone():
    sys.exit(f"❌  Account {ACCOUNT} not found in dashboard_users.")

print(f"✅  Seeding mock history for account: {ACCOUNT}")

# ══════════════════════════════════════════════════════════════════════════════
# MOCK WINDOW — the 4 calendar months immediately before the current one.
# The current month is never touched (that's where real activity lives).
# ══════════════════════════════════════════════════════════════════════════════
now = datetime.utcnow()

def month_back(n):
    """(year, month) for N calendar months before the current month."""
    month = now.month - n
    year  = now.year
    while month <= 0:
        month += 12
        year  -= 1
    return year, month

# Oldest → newest, e.g. run in July 2026 -> [(2026,3), (2026,4), (2026,5), (2026,6)]
MOCK_MONTHS = [month_back(n) for n in (4, 3, 2, 1)]
CURRENT_MONTH_START = datetime(now.year, now.month, 1).isoformat()
MOCK_WINDOW_START    = datetime(MOCK_MONTHS[0][0], MOCK_MONTHS[0][1], 1).isoformat()

print(f"    Mock window : {MOCK_MONTHS[0][1]:02d}/{MOCK_MONTHS[0][0]} → {MOCK_MONTHS[-1][1]:02d}/{MOCK_MONTHS[-1][0]}")
print(f"    Left alone  : {now.month:02d}/{now.year} (current month — real activity)")

def dt(month_idx, day, hour=10, minute=0):
    """ISO string for a given day within MOCK_MONTHS[month_idx] (0=oldest..3=newest)."""
    year, month = MOCK_MONTHS[month_idx]
    try:
        return datetime(year, month, day, hour, minute).isoformat()
    except ValueError:
        # day doesn't exist in this month (e.g. 31 in a 30-day month)
        return datetime(year, month, 28, hour, minute).isoformat()

# ══════════════════════════════════════════════════════════════════════════════
# CLEANUP — remove any previously-seeded rows in the mock window ONLY, so
# this script is safe to re-run. Never touches the current month.
# ══════════════════════════════════════════════════════════════════════════════
for table in ("income_transactions", "dashboard_transactions"):
    c.execute(
        f"DELETE FROM {table} WHERE account_number=%s AND created_at >= %s AND created_at < %s",
        (ACCOUNT, MOCK_WINDOW_START, CURRENT_MONTH_START)
    )
    print(f"  ✓  Cleared previous mock rows from {table} ({c.rowcount} removed)")

c.execute(
    "DELETE FROM bills WHERE account_number=%s AND created_at >= %s AND created_at < %s",
    (ACCOUNT, MOCK_WINDOW_START, CURRENT_MONTH_START)
)
print(f"  ✓  Cleared previous mock rows from bills ({c.rowcount} removed)")

# ══════════════════════════════════════════════════════════════════════════════
# 1. INCOME — 4 months
# ══════════════════════════════════════════════════════════════════════════════
# Same content every account, just placed under MOCK_MONTHS[i] for whichever
# 4 months are currently "the past 4 months" relative to today.
income_data = [
    # Month 0 (oldest)
    (ACCOUNT, 118000, 'Salary',       'Monthly salary',     dt(0, 1,  9)),
    (ACCOUNT,  15000, 'Freelance',    'Web design project', dt(0, 15, 14)),
    (ACCOUNT,  20000, 'Rental Income','Flat rent received', dt(0, 5,  11)),
    # Month 1
    (ACCOUNT, 120000, 'Salary',       'Monthly salary',     dt(1, 1,  9)),
    (ACCOUNT,  20000, 'Rental Income','Flat rent received', dt(1, 5,  11)),
    (ACCOUNT,   8000, 'Other',        'Sold old laptop',    dt(1, 20, 13)),
    # Month 2
    (ACCOUNT, 120000, 'Salary',        'Monthly salary',      dt(2, 1,  9)),
    (ACCOUNT,  22000, 'Freelance',     'App UI project',      dt(2, 10, 16)),
    (ACCOUNT,  20000, 'Rental Income', 'Flat rent received',  dt(2, 5,  11)),
    # Month 3 (most recent mock month, right before the real current month)
    (ACCOUNT, 122000, 'Salary',       'Monthly salary',     dt(3, 1,  9)),
    (ACCOUNT,  20000, 'Rental Income','Flat rent received', dt(3, 5,  11)),
]

c.executemany("""
    INSERT INTO income_transactions(account_number, amount, source, note, created_at)
    VALUES (%s, %s, %s, %s, %s)
""", income_data)
print(f"  ✓  Inserted {len(income_data)} income transactions")

# ══════════════════════════════════════════════════════════════════════════════
# 2. EXPENSES / TRANSFERS — 4 months
#    Categories match app.py's EXPENSE_CATEGORIES exactly, so the Spending
#    Breakdown card groups them correctly instead of dumping them into "Other".
# ══════════════════════════════════════════════════════════════════════════════

def tx(month_idx, day, desc, amount, category, biller=None, recipient=None,
       hour=12, tx_type='bill'):
    return (
        ACCOUNT, tx_type, desc, -abs(amount),
        recipient, biller, 'N/A', 'completed',
        dt(month_idx, day, hour), category, 0.0
    )

transactions = []
for m in range(4):
    # Fixed monthly costs — present every month
    transactions += [
        tx(m, 1, 'House rent',              45000, 'Rent',                hour=8),
        tx(m, 1, 'Maid salary',              8000, 'Household Staff',     hour=10),
        tx(m, 2, 'Bahria Town maintenance',  5500, 'Society Maintenance', hour=9),
        tx(m, 1, 'Netflix subscription',     1200, 'Entertainment',       hour=12),
        tx(m, 6, 'Stormfiber Internet',      3500, 'Utility Bills', biller='Stormfiber'),
    ]

# K-Electric bill — creeps up into summer, matching a believable usage pattern
for m, amt in zip(range(4), (4200, 4500, 5200, 4900)):
    transactions.append(tx(m, 3, 'K-Electric Bill', amt, 'Utility Bills', biller='K-Electric'))

# Grocery — two trips a month, slowly increasing
for m, (a1, a2) in zip(range(4), [(11000, 8000), (12000, 8500), (13000, 9200), (11500, 9000)]):
    transactions.append(tx(m, 7,  'Imtiaz Supermarket', a1, 'Grocery', hour=11))
    transactions.append(tx(m, 21, 'Carrefour grocery',  a2, 'Grocery', hour=15))

# Car & Fuel
for m, amt in zip(range(4), (5500, 6000, 7200, 5800)):
    transactions.append(tx(m, 10, 'Shell petrol', amt, 'Car & Fuel', hour=8))

# Medical — not every month, on purpose (realistic, not evenly distributed)
transactions += [
    tx(1, 16, 'Doctor — dermatologist', 2500, 'Medical', hour=14),
    tx(2, 20, 'Dentist visit',          5000, 'Medical', hour=11),
    tx(3, 19, 'Aga Khan pharmacy',      1800, 'Medical', hour=16),
]

# One-off entertainment/education spikes, spread across different months
transactions += [
    tx(0, 22, 'Daraz.pk order',       4200,  'Entertainment', hour=14),
    tx(2, 18, 'Zara clothing',        8500,  'Entertainment', hour=16),
    tx(2, 5,  'Fee deposit — school', 25000, 'Education',     hour=10),
]

# Transfers — mix of a plain (uncategorized) transfer and a couple of
# categorized ones, so both display paths are exercised in the demo.
transactions += [
    tx(0, 25, 'Transfer to Ahmed', 10000, 'Transfer', recipient='Ahmed Khan',  tx_type='transfer'),
    tx(1, 28, 'Transfer to Sara',  6000,  'Grocery',  recipient='Sara Ali',    tx_type='transfer'),
    tx(3, 14, 'Transfer to Bilal', 4000,  'Other',    recipient='Bilal Aslam', tx_type='transfer'),
]

c.executemany("""
    INSERT INTO dashboard_transactions
        (account_number, transaction_type, description, amount,
         recipient, biller, bill_id, status, created_at, category, fee)
    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
""", transactions)
print(f"  ✓  Inserted {len(transactions)} expense/transfer transactions")

# ══════════════════════════════════════════════════════════════════════════════
# 3. BILLS — paid history across the mock window, feeds anomaly detection
#    (amount-spike / new-biller checks) and the saved-billing-account prompt.
#    No synthetic "pending" bill is added here on purpose — pending bills
#    should come from real, current-month activity, not mock data.
# ══════════════════════════════════════════════════════════════════════════════
bills = []
for m, amt in zip(range(4), (4200, 4500, 5200, 4900)):
    bills.append((ACCOUNT, 'K-Electric', amt, dt(m, 10)[:10], 'paid', dt(m, 3)[:10], f'KE-{m}', dt(m, 1)))
for m in range(4):
    bills.append((ACCOUNT, 'Stormfiber', 3500, dt(m, 8)[:10], 'paid', dt(m, 6)[:10], f'SF-{m}', dt(m, 1)))

c.executemany("""
    INSERT INTO bills(account_number, biller, amount, due_date, status, paid_on, ref, created_at)
    VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
""", bills)
print(f"  ✓  Inserted {len(bills)} paid bill records")

conn.commit()
conn.close()

print("\n🎉  Mock history seeded successfully!")
print(f"    Account      : {ACCOUNT}")
print(f"    Mock months  : {MOCK_MONTHS[0][1]:02d}/{MOCK_MONTHS[0][0]} – {MOCK_MONTHS[-1][1]:02d}/{MOCK_MONTHS[-1][0]}")
print(f"    Current month: {now.month:02d}/{now.year} — untouched, reflects real activity")
print(f"    Balance/points: not modified — whatever this account currently has stays as-is")
print(f"\n    Financial Advisor should now show {len(MOCK_MONTHS) + 1} months of trend data.")
print(f"    Re-running this script for the same account is safe — it refreshes")
print(f"    the mock months only and never touches the current month.")