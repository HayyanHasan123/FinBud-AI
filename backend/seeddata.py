# seed_data.py — FinBud AI
# ─────────────────────────────────────────────────────────────────────────────
# Inserts a full 12-month history onto an ACCOUNT YOU ALREADY REGISTERED —
# same convention your team already uses: sign up normally in the app,
# then run this script with your account_number to fill your own account
# with a realistic full year of data across every feature (transactions,
# goals, credit score, anomaly/fraud, rewards, KYC, a support ticket).
#
# USAGE:
#   1. Make sure your .env file has DATABASE_URL set correctly.
#   2. Sign up in the app normally first (so the account exists).
#   3. Run:  python seed_data.py <account_number>
#      e.g.: python seed_data.py ACC20260622123456
#
# SAFE TO RUN MULTIPLE TIMES — unlike a plain INSERT script, this one
# clears its own previously-seeded rows for that account before
# reinserting, so re-running just refreshes your 12 months instead of
# duplicating them.
# ─────────────────────────────────────────────────────────────────────────────

import os
import sys
from datetime import datetime, timedelta
from timezone_utils import now_pk, today_pk

import psycopg2
import psycopg2.extras
from dotenv import load_dotenv

load_dotenv()


def run_seed(account_number, database_url=None):
    """
    Seeds a full 12-month mock-data history onto an ALREADY-REGISTERED
    account. Importable — call this from app.py to auto-seed on startup,
    or run this file directly:  python seed_data.py <account_number>

    Safe to call every time the app starts: it clears its own previously
    seeded rows for that account first, so re-running just refreshes the
    12 months instead of duplicating them.
    """
    ACCOUNT = account_number
    DATABASE_URL = database_url or os.getenv("DATABASE_URL")
    if not DATABASE_URL:
        raise RuntimeError("DATABASE_URL not set in .env")

    conn = psycopg2.connect(DATABASE_URL)
    conn.cursor_factory = psycopg2.extras.RealDictCursor
    c = conn.cursor()

    # ── Verify account exists — never creates one, only enriches a real account ─
    c.execute("SELECT id, name, phone FROM dashboard_users WHERE account_number=%s", (ACCOUNT,))
    user = c.fetchone()
    if not user:
        conn.close()
        raise ValueError(f"Account {ACCOUNT} not found in dashboard_users. Sign up in the app first.")

    NAME  = user["name"]
    PHONE = user["phone"] or "0300-0000000"
    print(f"[seed_data] Seeding 12 months of mock data for: {NAME} ({ACCOUNT})")

    # ── Extra tables this script owns (not created anywhere else in the app) ──────
    c.execute('''
        CREATE TABLE IF NOT EXISTS credit_score_history (
            id               SERIAL PRIMARY KEY,
            account_number   VARCHAR(30) NOT NULL,
            month            VARCHAR(7)  NOT NULL,
            score            INTEGER,
            label            VARCHAR(20),
            late_payments    INTEGER,
            balance          NUMERIC(15,2),
            transactions_6m  INTEGER,
            reward_points    INTEGER,
            created_at       VARCHAR(64)
        )
    ''')
    c.execute('''
        CREATE TABLE IF NOT EXISTS reward_points_log (
            id               SERIAL PRIMARY KEY,
            account_number   VARCHAR(30) NOT NULL,
            points           INTEGER,
            reason           TEXT,
            created_at       VARCHAR(64)
        )
    ''')
    c.execute('''
        CREATE TABLE IF NOT EXISTS card_lock_logs (
            id               SERIAL PRIMARY KEY,
            account_number   VARCHAR(30) NOT NULL,
            card_number      VARCHAR(20),
            action           VARCHAR(10),
            reason           TEXT,
            created_at       VARCHAR(64)
        )
    ''')
    conn.commit()

    # ── Cleanup — wipe any previously-seeded rows for THIS account only ───────────
    # NOTE: transfer_fees references dashboard_transactions.id via a foreign
    # key (transfer_fees_transaction_id_fkey), so it MUST be cleared first —
    # otherwise deleting dashboard_transactions rows that still have a fee
    # attached fails with a ForeignKeyViolation. transfer_fees has no
    # account_number column of its own, so we match it via a subquery on
    # the transaction ids that belong to this account.
    c.execute("""
        DELETE FROM transfer_fees
        WHERE transaction_id IN (
            SELECT id FROM dashboard_transactions WHERE account_number = %s
        )
    """, (ACCOUNT,))
    for table in ("dashboard_transactions", "income_transactions", "bills",
                  "cards", "fraud_alerts", "card_lock_logs",
                  "savings_goals", "credit_score_history", "reward_points_log",
                  "redemptions", "late_payments", "kyc_submissions",
                  "handoff_queue", "chat_history"):
        c.execute(f"DELETE FROM {table} WHERE account_number=%s", (ACCOUNT,))
    conn.commit()
    print("  ✓  Cleared previous seed rows for this account across all owned tables")

    # ── Date helpers — 12 calendar months, oldest → newest, ending THIS month ─────
    now = now_pk()

    def month_back(n):
        month, year = now.month - n, now.year
        while month <= 0:
            month += 12
            year -= 1
        return year, month

    MONTHS = [month_back(n) for n in range(11, -1, -1)]   # index 0 = 11 months ago ... 11 = this month

    def dt(i, day, hour=12, minute=0):
        year, month = MONTHS[i]
        try:
            return datetime(year, month, day, hour, minute).isoformat()
        except ValueError:
            return datetime(year, month, 28, hour, minute).isoformat()

    def cap_day(i, day):
        """
        Clamp a day-of-month to TODAY for the current month (index 11) so
        that no real event (income, expense, bill, reward) is ever dated
        in the future relative to whenever this script actually runs.
        Goal target_dates deliberately do NOT use this — those are meant
        to be future dates.
        """
        return min(day, now.day) if i == 11 else day

    # Counts how many current-month events have had to be pulled back below
    # "now" — each one gets staggered a minute further back so they don't
    # all collide on one exact timestamp.
    _clamp_counter = [0]

    def dt_capped(i, day, hour=12, minute=0):
        """
        Like dt(), but for the CURRENT month (index 11) also clamps the
        full timestamp — not just the day — to strictly before "now".
        This guarantees every seeded event this month is older than any
        real transaction the user makes live in the app afterward, so a
        fresh transaction always sorts to the top of "Recent Transactions"
        instead of being buried under same-day seeded entries at a later
        clock hour.
        """
        raw = dt(i, cap_day(i, day), hour, minute)
        if i == 11:
            raw_dt = datetime.fromisoformat(raw)
            if raw_dt >= now:
                _clamp_counter[0] += 1
                raw_dt = now - timedelta(minutes=_clamp_counter[0])
            return raw_dt.isoformat()
        return raw

    # ── Deliberate anomalies — anchored to a fixed point BEFORE the start of
    #    the current calendar month, guaranteeing two things simultaneously,
    #    regardless of what day-of-month this script happens to run on:
    #      1. It NEVER lands in "this month" (which would wreck Safe-to-Spend/
    #         Income-vs-Expense, since those only sum the current calendar month).
    #      2. It's always recent enough (well under 60 days) to still show up
    #         in the live Anomaly Alerts panel, which only scans the trailing
    #         60 days.
    #    A fixed "N days ago" (what this used to be) does NOT guarantee #1 —
    #    it can drift back into the current month depending on which day of
    #    the month the script is run on, which is exactly what happened.
    this_month_start = datetime(now.year, now.month, 1)
    anomaly_dt = this_month_start - timedelta(days=3)   # solidly in the previous month, always

    def anomaly_ts(hour, minute=0):
        return anomaly_dt.replace(hour=hour, minute=minute, second=0, microsecond=0).isoformat()

    # ══════════════════════════════════════════════════════════════════════════════
    # 1. CARD
    #    Linked bank accounts used to be seeded here too, back when they were
    #    a plain `bank_accounts` row with no real flow behind it. Now that
    #    linking goes through the actual AISP mock-consent flow (login ->
    #    scope consent -> aisp_consents/aisp_account_snapshots/aisp_transactions),
    #    seeding one here would mean faking a consent record with no real
    #    grant behind it — so linked accounts are intentionally NOT seeded.
    #    To see the Wallet tab's linked-account UI populated, go through
    #    Wallet -> Connect via MockBank (Demo AISP) in the running app.
    # ══════════════════════════════════════════════════════════════════════════════
    CARD_LAST4 = "4821"
    c.execute("""
        INSERT INTO cards(account_number, card_number, cardholder_name, expiry, nickname, status)
        VALUES (%s, %s, %s, %s, %s, 'active')
    """, (ACCOUNT, CARD_LAST4, NAME.upper(), "09/29", "Primary Card"))
    print(f"  ✓  Linked 1 card")

    # ══════════════════════════════════════════════════════════════════════════════
    # 2. 12-MONTH FINANCIAL SIMULATION
    #    Needs ~50% / Wants ~30% / Savings ~20% of monthly salary, with a
    #    running-balance check that guarantees the balance never goes negative.
    # ══════════════════════════════════════════════════════════════════════════════
    SALARY_BASE  = 195000
    BONUS_MONTH  = 6
    BONUS_AMOUNT = 55000
    INIT_BALANCE = 300000

    KE      = [4200, 4100, 4400, 4900, 5600, 6800, 7600, 7400, 6600, 5400, 4600, 4300]
    SSGC    = [3200, 3000, 2400, 1800, 1200,  900,  800,  850, 1100, 1700, 2600, 3100]
    JAZZ    = [2500, 2500, 2500, 2500, 2500, 3200, 2500, 2500, 2500, 2500, 2500, 2500]
    GROCERY = [(11000, 8200), (11200, 8300), (11500, 8600), (11800, 8700),
               (12000, 9000), (12300, 9200), (12500, 9300), (12700, 9500),
               (13000, 9700), (13200, 9900), (13500, 10100), (13800, 10300)]
    FUEL    = [7500, 7800, 8200, 8600, 9000, 9400, 9600, 9200, 8800, 8400, 8000, 7700]
    DINING  = [5500, 6000, 5800, 6200, 6500, 7000, 7200, 6800, 6400, 6000, 5800, 6200]
    SHOP    = [8000, 7500, 9000, 8500, 10000, 11000, 9500, 8800, 8200, 9200, 8700, 9600]
    MEDICAL = {2: 2500, 7: 4200, 10: 1800}
    EDU     = {4: 22000}
    LATE_PAYMENT_MONTH = 3

    GOALS = [
        {"name": "Emergency Fund",        "type": "emergency_fund", "monthly": 15000, "target": 300000},
        {"name": "House Down Payment",    "type": "house",          "monthly": 15000, "target": 600000},
        {"name": "Dream Vacation - Japan","type": "custom",         "monthly": 9000,  "target": 150000},
    ]

    income_rows, tx_rows, bill_rows = [], [], []
    savings_progress = {g["name"]: 0 for g in GOALS}

    def credit(i, day, amount, source, note, hour=9):
        income_rows.append((ACCOUNT, amount, source, note, dt_capped(i, day, hour)))

    def debit(i, day, amount, desc, category, hour=12, biller=None, recipient=None,
              tx_type="bill", minute=0):
        tx_rows.append((ACCOUNT, tx_type, desc, -abs(amount), recipient, biller,
                         "N/A", "completed", dt_capped(i, day, hour, minute), category, 0.0))

    for i in range(12):
        salary = SALARY_BASE + (BONUS_AMOUNT if i == BONUS_MONTH else 0)
        credit(i, 1, salary, "Salary", "Monthly salary" + (" + annual bonus" if i == BONUS_MONTH else ""))

        debit(i, 1, 45000, "House rent", "Rent", hour=8)
        debit(i, 2, 8000, "Maid salary", "Household Staff", hour=10)
        debit(i, 2, 5500, "Society maintenance", "Society Maintenance", hour=9)
        debit(i, 5, KE[i], "K-Electric bill", "Utility Bills", biller="K-Electric")
        debit(i, 8, SSGC[i], "SSGC gas bill", "Utility Bills", biller="SSGC")
        debit(i, 10, JAZZ[i], "Jazz postpaid bill", "Utility Bills", biller="Jazz")
        debit(i, 7, GROCERY[i][0], "Imtiaz Supermarket", "Grocery", hour=11)
        debit(i, 21, GROCERY[i][1], "Carrefour grocery", "Grocery", hour=15)
        if i in MEDICAL:
            debit(i, 16, MEDICAL[i], "Aga Khan clinic visit", "Medical", hour=14)
        if i in EDU:
            debit(i, 5, EDU[i], "Certification course fee", "Education", hour=10)

        # NOTE: reference numbers must be digits-only to match the new
        # numeric-only bill_reference validation (extract_bill_reference()
        # in nlp_module.py) and the Dashboard's PayBillStep3 "saved
        # reference" quick-fill button, which sends this value straight
        # back through that same validation. Previously these used
        # letter-prefixed refs ("KE-{i}", "SSGC-{i}") which would fail the
        # new check if a user clicked "Yes" on a legacy saved ref.
        bill_rows.append((ACCOUNT, "K-Electric", KE[i], dt_capped(i, 10)[:10], "paid",
                           dt_capped(i, 5)[:10], f"1100{i:03d}", dt_capped(i, 1)))
        paid_day = 20 if i == LATE_PAYMENT_MONTH else 8
        paid_on = dt_capped(i, paid_day)[:10]
        bill_rows.append((ACCOUNT, "SSGC", SSGC[i], dt_capped(i, 12)[:10], "paid",
                           paid_on, f"2200{i:03d}", dt_capped(i, 1)))

        debit(i, 10, FUEL[i], "Shell petrol", "Car & Fuel", hour=8)
        debit(i, 14, DINING[i], "Dinner - restaurant", "Entertainment", hour=20)
        debit(i, 24, SHOP[i], "Daraz / mall shopping", "Entertainment", hour=17)

        # Current month's (i == 11) auto-debit for goal contributions is
        # deliberately SKIPPED here. Safe-to-Spend already reserves 20% of
        # income for savings + 10% for investment on its own (see
        # features.py::get_income_vs_expense) — if this month's contribution
        # is ALSO booked as a real debit, that same money gets subtracted
        # twice, and Safe-to-Spend comes out negative (clamped to PKR 0)
        # even though the user is behaving exactly as intended. Treating
        # it as "scheduled for later this month, not yet auto-debited" is
        # both realistic and keeps Safe-to-Spend positive. Past months keep
        # the real debit so transaction history / balance stay accurate,
        # and savings_progress is still credited every month so the Goals
        # panel keeps showing full 12-month progress.
        for g in GOALS:
            if i < 11:
                debit(i, 27, g["monthly"], f"Savings goal contribution — {g['name']}",
                      "Savings", hour=19, tx_type="transfer", recipient=f"Own Savings – {g['name']}")
            savings_progress[g["name"]] += g["monthly"]


    anomaly_tx_rows = [
    # Moved to a normal daytime hour (14:30) so this triggers ONLY
    # large_transfer, not also odd_hours — keeps the two anomaly
    # types cleanly separate instead of double-counting one event.
    (ACCOUNT, "withdrawal", "ATM/POS withdrawal - unrecognised merchant", -150000.0,
     None, None, "N/A", "completed", anomaly_ts(14, 30), "Other", 0.0),
    ]
    # Trimmed to exactly 3 (minimum needed for rapid_fire's >=3-in-10-min
    # check) so this cluster produces exactly 1 rapid_fire alert AND
    # exactly 3 odd_hours alerts — nothing more.
    for k, (minute, amt) in enumerate(zip((47, 49, 51), (2800, 3100, 2600))):
        anomaly_tx_rows.append(
            (ACCOUNT, "pos_purchase", f"POS purchase #{k+1} - unknown merchant", -float(amt),
             None, None, "N/A", "completed", anomaly_ts(3, minute), "Other", 0.0)
        )
    tx_rows.extend(anomaly_tx_rows)

    # ── Running-balance safety check — guarantees the balance never goes negative ─
    combined = ([(r[4], float(r[1])) for r in income_rows] +
                [(r[8], float(r[3])) for r in tx_rows])
    combined.sort(key=lambda x: x[0])
    check_balance = INIT_BALANCE
    for ts, amt in combined:
        check_balance += amt
        if check_balance < 0:
            sys.exit(f"❌  Simulation produced a negative balance ({check_balance:.2f}) at {ts}.")
    final_balance = check_balance
    print(f"  ✓  Running-balance check passed — never negative (final: PKR {final_balance:,.2f})")

    c.executemany("""
        INSERT INTO income_transactions(account_number, amount, source, note, created_at)
        VALUES (%s, %s, %s, %s, %s)
    """, income_rows)
    c.executemany("""
        INSERT INTO dashboard_transactions
            (account_number, transaction_type, description, amount,
             recipient, biller, bill_id, status, created_at, category, fee)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
    """, tx_rows)
    c.executemany("""
        INSERT INTO bills(account_number, biller, amount, due_date, status, paid_on, ref, created_at)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
    """, bill_rows)
    conn.commit()
    print(f"  ✓  Inserted {len(income_rows)} income rows, {len(tx_rows)} transactions, {len(bill_rows)} bills")

    c.execute("""
        INSERT INTO late_payments(account_number, reason, due_date, paid_on)
        VALUES (%s, %s, %s, %s)
    """, (ACCOUNT, "SSGC gas bill paid after due date", dt(LATE_PAYMENT_MONTH, 12)[:10],
          dt(LATE_PAYMENT_MONTH, 20)[:10]))
    conn.commit()

    # ══════════════════════════════════════════════════════════════════════════════
    # 3. SAVINGS GOALS — final progressive totals after 12 months
    #    (month-by-month contribution history lives in dashboard_transactions
    #     above, category='Savings' — this row holds the running total.)
    # ══════════════════════════════════════════════════════════════════════════════
    goal_rows = [
        (ACCOUNT, g["type"], g["name"], g["target"], dt(11, 28)[:10],
         savings_progress[g["name"]], dt(0, 3, 10), "monthly", 12, g["monthly"])
        for g in GOALS
    ]
    c.executemany("""
        INSERT INTO savings_goals
            (account_number, goal_type, goal_name, target_amount, target_date,
             saved_amount, created_at, frequency, timeline_months, per_period_amount)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
    """, goal_rows)
    conn.commit()
    print(f"  ✓  Seeded {len(goal_rows)} savings goals with 12 months of contributions")

    # ══════════════════════════════════════════════════════════════════════════════
    # 4. REWARD POINTS — monthly earn events + 2 redemptions
    # ══════════════════════════════════════════════════════════════════════════════
    reward_log, total_points = [], 0
    for i in range(12):
        earn_bill = round((KE[i] + SSGC[i] + JAZZ[i]) / 100)
        reward_log.append((ACCOUNT, earn_bill, "Cashback on utility bill payments", dt_capped(i, 11, 18)))
        reward_log.append((ACCOUNT, 150, "Monthly spend milestone bonus", dt_capped(i, 28, 18)))
        total_points += earn_bill + 150
    c.executemany("""
        INSERT INTO reward_points_log(account_number, points, reason, created_at)
        VALUES (%s, %s, %s, %s)
    """, reward_log)

    redemptions = [(ACCOUNT, 500, 500.0, dt(5, 15, 13)), (ACCOUNT, 1000, 1200.0, dt(9, 20, 15))]
    c.executemany("""
        INSERT INTO redemptions(account_number, points_used, reward_value, created_at)
        VALUES (%s, %s, %s, %s)
    """, redemptions)
    total_points -= sum(r[1] for r in redemptions)
    conn.commit()

    c.execute("UPDATE dashboard_users SET points=%s, balance=%s WHERE account_number=%s",
              (total_points, round(final_balance, 2), ACCOUNT))
    c.execute("""
        INSERT INTO rewards(account_number, points) VALUES (%s, %s)
        ON CONFLICT (account_number) DO UPDATE SET points = EXCLUDED.points
    """, (ACCOUNT, total_points))
    conn.commit()
    print(f"  ✓  Reward history seeded — {total_points} points net of 2 redemptions")

    # ══════════════════════════════════════════════════════════════════════════════
    # 5. ANOMALY DETECTION & SECURITY — fraud alerts + card lock log
    # ══════════════════════════════════════════════════════════════════════════════
        # Withdrawal is now at 14:30 (not odd hours), so only the large_transfer
    # alert applies to it — the separate odd_hours alert for it is removed.
    c.execute("""
        INSERT INTO fraud_alerts(account_number, message, anomaly_type, status, created_at)
        VALUES (%s, %s, %s, %s, %s)
    """, (ACCOUNT, "Debit of PKR 150,000 is far above this account's typical transaction size.",
          "large_transfer", "unreviewed", anomaly_ts(14, 31)))
    c.execute("""
        INSERT INTO fraud_alerts(account_number, message, anomaly_type, status, created_at)
        VALUES (%s, %s, %s, %s, %s)
    """, (ACCOUNT, "3 debit transactions within a 10-minute window (03:47-03:51).",
          "rapid_fire", "unreviewed", anomaly_ts(3, 52)))
    conn.commit()

    c.execute("UPDATE cards SET status='locked' WHERE account_number=%s", (ACCOUNT,))
    c.execute("""
        INSERT INTO card_lock_logs(account_number, card_number, action, reason, created_at)
        VALUES (%s, %s, 'locked', %s, %s)
    """, (ACCOUNT, CARD_LAST4, "Auto-lock: large debit + rapid-fire transactions flagged.",
          anomaly_ts(4, 0)))
    c.execute("UPDATE cards SET status='active' WHERE account_number=%s", (ACCOUNT,))
    c.execute("""
        INSERT INTO card_lock_logs(account_number, card_number, action, reason, created_at)
        VALUES (%s, %s, 'unlocked', %s, %s)
    """, (ACCOUNT, CARD_LAST4, "Reviewed and confirmed by customer via support - card reactivated.",
          anomaly_ts(10, 0)))
    conn.commit()
    print("  ✓  Seeded fraud alerts (odd_hours, large_transfer, rapid_fire) + card lock/unlock log")

    # ══════════════════════════════════════════════════════════════════════════════
    # 6. SUPPORT TICKET + CHAT LOG (tied to the fraud incident)
    # ══════════════════════════════════════════════════════════════════════════════
    c.execute("""
        INSERT INTO handoff_queue(account_number, reason, status, created_at, resolution_note)
        VALUES (%s, %s, 'resolved', %s, %s)
    """, (ACCOUNT, "Card auto-locked after suspicious late-night activity - customer wants to verify and reactivate.",
          anomaly_ts(4, 1),
          "Verified with customer by phone; charges confirmed as their own late-night purchases. Card reactivated."))

    chat_rows = [
        (ACCOUNT, "Why is my card locked?! I see a huge withdrawal I don't recognise.",
         "I've locked your card as a safety precaution because of the unusual time and amount. Connecting you to a support agent now.",
         "fraud_alert", anomaly_ts(4, 2)),
        (ACCOUNT, "It was me — I was at a late-night sale and made a few quick purchases.",
         "Thanks for confirming. I've reactivated your card and closed this alert.",
         "handoff_resolved", anomaly_ts(10, 1)),
    ]
    c.executemany("""
        INSERT INTO chat_history(account_number, user_message, ai_response, intent, created_at)
        VALUES (%s, %s, %s, %s, %s)
    """, chat_rows)
    conn.commit()
    print("  ✓  Seeded 1 resolved support ticket with chat log")

    # ══════════════════════════════════════════════════════════════════════════════
    # 7. KYC — approved
    # ══════════════════════════════════════════════════════════════════════════════
    c.execute("""
        INSERT INTO kyc_submissions
            (account_number, cnic_number, selfie_url, cnic_front_url,
             status, submitted_at, reviewed_at)
        VALUES (%s, %s, %s, %s, 'approved', %s, %s)
    """, (ACCOUNT, "42101-1234567-1", "https://cdn.finbud.ai/kyc/demo/selfie.jpg",
          "https://cdn.finbud.ai/kyc/demo/cnic_front.jpg", dt(0, 2, 9), dt(0, 3, 10)))
    conn.commit()
    print("  ✓  KYC submission approved")

    # ══════════════════════════════════════════════════════════════════════════════
    # 8. MONTHLY CREDIT SCORE HISTORY (replicates features.py::generate_credit_score())
    # ══════════════════════════════════════════════════════════════════════════════
    tx_dates = sorted(r[8] for r in tx_rows)
    score_rows = []
    for i in range(12):
        month_end = dt(i, 28, 23, 59)
        running_balance = (INIT_BALANCE
                            + sum(float(r[1]) for r in income_rows if r[4] <= month_end)
                            + sum(float(r[3]) for r in tx_rows if r[8] <= month_end))
        late_count = 1 if i >= LATE_PAYMENT_MONTH else 0
        cutoff = dt(max(0, i - 5), 1, 0)
        tx_6m = sum(1 for ts in tx_dates if cutoff <= ts <= month_end)
        points_as_of = max(
            sum(r[1] for r in reward_log if r[3] <= month_end) -
            sum(r[1] for r in redemptions if r[3] <= month_end), 0)

        score = 650
        score -= min(late_count * 40, 200)
        score += min(int(running_balance / 1000), 100)
        score += min(tx_6m * 2, 50)
        score += min(int(points_as_of / 20), 50)
        score = max(300, min(850, score))
        label = ("Excellent" if score >= 750 else "Good" if score >= 650
                 else "Fair" if score >= 500 else "Poor")

        year, month = MONTHS[i]
        score_rows.append((ACCOUNT, f"{year}-{month:02d}", score, label, late_count,
                            round(running_balance, 2), tx_6m, int(points_as_of), month_end))

    c.executemany("""
        INSERT INTO credit_score_history
            (account_number, month, score, label, late_payments, balance,
             transactions_6m, reward_points, created_at)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
    """, score_rows)
    conn.commit()
    print(f"  ✓  Credit score history: {score_rows[0][2]} → {score_rows[-1][2]} "
          f"({score_rows[0][3]} → {score_rows[-1][3]})")

    conn.close()

    print("\n🎉  12-month mock data seeded successfully!")
    print(f"    Account         : {ACCOUNT} ({NAME})")
    print(f"    Period          : {MONTHS[0][1]:02d}/{MONTHS[0][0]} → {MONTHS[-1][1]:02d}/{MONTHS[-1][0]}")
    print(f"    Final balance   : PKR {final_balance:,.2f}  (never went negative)")
    print(f"    Reward points   : {total_points}")
    print(f"    Savings goals   : {len(GOALS)} goals, PKR {sum(savings_progress.values()):,} saved total")
    print(f"    Fraud alerts    : 3 (odd_hours, large_transfer, rapid_fire) — status: pending review")
    print(f"    Support tickets : 1 resolved, with chat log")
    print(f"    KYC             : approved")
    print(f"\n    Run your app and log in to {ACCOUNT} — Financial Advisor, Goals, Rewards,")
    print(f"    Fraud alerts and Admin dashboards should all be populated now.")

    return {
        "account": ACCOUNT, "name": NAME, "final_balance": round(final_balance, 2),
        "reward_points": total_points, "period": f"{MONTHS[0][1]:02d}/{MONTHS[0][0]} → {MONTHS[-1][1]:02d}/{MONTHS[-1][0]}",
    }


if __name__ == "__main__":
    # Standalone usage:  python seed_data.py <account_number>
    if len(sys.argv) < 2:
        sys.exit("❌  Usage: python seed_data.py <account_number>")
    try:
        run_seed(sys.argv[1])
    except (RuntimeError, ValueError) as e:
        sys.exit(f"❌  {e}")