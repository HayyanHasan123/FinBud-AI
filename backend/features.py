# features.py  –  FinBud AI (PostgreSQL Edition)
# ─────────────────────────────────────────────────────────────────────────────
# CHANGES vs SQLite version:
#   1. `sqlite3` and `_conn()` removed; uses the shared pool from app.py via
#      get_pg_conn() / release_pg_conn() defined at the bottom of this file.
#   2. All SQL placeholders changed from  ?  →  %s  (PostgreSQL standard).
#   3. `c.lastrowid` replaced with  RETURNING id  + fetchone()['id'].
#   4. Rows accessed by column name via RealDictCursor (set in app.py pool).
#   5. `INTEGER PRIMARY KEY AUTOINCREMENT` → `SERIAL PRIMARY KEY`.
#   6. `INSERT OR IGNORE` → `INSERT ... ON CONFLICT DO NOTHING`.
#   7. `ON CONFLICT(account_number) DO UPDATE` syntax is identical in Postgres.
#   8. DATABASE_URL loaded from .env (already done by app.py before import).
#
# All function names, logic, constants, and return shapes are IDENTICAL
# to the original SQLite version.
# ─────────────────────────────────────────────────────────────────────────────

import psycopg2
import psycopg2.extras
from psycopg2 import pool as psycopg2_pool

import os
from datetime import datetime, date
from dotenv import load_dotenv

load_dotenv()

# ── Standalone connection pool for features.py ────────────────────────────────
# features.py functions are called from app.py but also run independently,
# so we maintain our own pool rather than importing app.py's pool
# (which would create a circular import).
_DATABASE_URL = os.getenv("DATABASE_URL")
if not _DATABASE_URL:
    raise RuntimeError("DATABASE_URL not set. Check your .env file.")

_pool = psycopg2_pool.ThreadedConnectionPool(
    minconn=1,
    maxconn=5,
    dsn=_DATABASE_URL
)


def get_pg_conn():
    conn = _pool.getconn()
    conn.cursor_factory = psycopg2.extras.RealDictCursor
    return conn


def release_pg_conn(conn):
    _pool.putconn(conn)


# ---------- DATABASE INIT ----------
def init_db():
    conn = get_pg_conn()
    c = conn.cursor()

    # users
    c.execute('''
    CREATE TABLE IF NOT EXISTS users (
        account_number VARCHAR(30) PRIMARY KEY,
        name           VARCHAR(120),
        phone          VARCHAR(20),
        language       VARCHAR(10)
    )''')

    # transactions
    c.execute('''
    CREATE TABLE IF NOT EXISTS transactions (
        id             SERIAL PRIMARY KEY,
        account_number VARCHAR(30),
        date           VARCHAR(64),
        description    TEXT,
        amount         NUMERIC(15,2)
    )''')

    # rewards
    c.execute('''
    CREATE TABLE IF NOT EXISTS rewards (
        account_number VARCHAR(30) PRIMARY KEY,
        points         INTEGER DEFAULT 0
    )''')

    # reminders
    c.execute('''
    CREATE TABLE IF NOT EXISTS reminders (
        id             SERIAL PRIMARY KEY,
        account_number VARCHAR(30),
        bill_type      VARCHAR(60),
        due_date       VARCHAR(20),
        amount         NUMERIC(15,2),
        sent           INTEGER DEFAULT 0
    )''')

    # handoff queue
    c.execute('''
    CREATE TABLE IF NOT EXISTS handoff_queue (
        id             SERIAL PRIMARY KEY,
        account_number VARCHAR(30),
        reason         TEXT,
        status         VARCHAR(20) DEFAULT 'pending',
        created_at     VARCHAR(64)
    )''')

    # late payments
    c.execute('''
    CREATE TABLE IF NOT EXISTS late_payments (
        id             SERIAL PRIMARY KEY,
        account_number VARCHAR(30),
        reason         TEXT,
        due_date       VARCHAR(20),
        paid_on        VARCHAR(20)
    )''')

    # Bills table
    c.execute('''
    CREATE TABLE IF NOT EXISTS bills (
        id             SERIAL PRIMARY KEY,
        account_number VARCHAR(30),
        biller         VARCHAR(120),
        amount         NUMERIC(15,2),
        due_date       VARCHAR(20),
        status         VARCHAR(20) DEFAULT 'unpaid',
        paid_on        VARCHAR(20),
        ref            VARCHAR(60),
        created_at     VARCHAR(64)
    )''')

    # Reminders log
    c.execute('''
    CREATE TABLE IF NOT EXISTS reminders_log (
        id             SERIAL PRIMARY KEY,
        account_number VARCHAR(30),
        bill_id        INTEGER,
        kind           VARCHAR(20),
        message        TEXT,
        due_date       VARCHAR(20),
        days_left      INTEGER,
        created_at     VARCHAR(64)
    )''')

    # Conversation state
    c.execute('''
    CREATE TABLE IF NOT EXISTS conversation_state (
        account_number VARCHAR(30) PRIMARY KEY,
        mode           VARCHAR(20) DEFAULT 'bot',
        assigned_to    VARCHAR(60),
        updated_at     VARCHAR(64)
    )''')

    # Cards table
    c.execute('''
    CREATE TABLE IF NOT EXISTS cards (
        id             SERIAL PRIMARY KEY,
        account_number VARCHAR(30),
        card_number    VARCHAR(20),
        status         VARCHAR(20) DEFAULT 'active',
        cardholder_name TEXT,
        expiry          TEXT,
        nickname        TEXT
    )''')

    # Fraud alerts
    c.execute('''
    CREATE TABLE IF NOT EXISTS fraud_alerts (
        id             SERIAL PRIMARY KEY,
        account_number VARCHAR(30),
        message        TEXT,
        created_at     VARCHAR(64)
    )''')

    # Income transactions — Financial Advisor panel
    # One row per income entry logged by the user (salary, rental, PSX, etc.)
    c.execute('''
    CREATE TABLE IF NOT EXISTS income_transactions (
        id             SERIAL PRIMARY KEY,
        account_number VARCHAR(30)    NOT NULL,
        amount         NUMERIC(15,2)  NOT NULL,
        source         VARCHAR(120),
        note           TEXT,
        created_at     VARCHAR(64)
    )''')

    # Bank accounts — Digital Wallet tab
    # Stores bank-linking requests; status starts as 'pending'
    c.execute('''
    CREATE TABLE IF NOT EXISTS bank_accounts (
        id             SERIAL PRIMARY KEY,
        account_number VARCHAR(30)  NOT NULL,
        bank_name      VARCHAR(120),
        iban           VARCHAR(34),
        status         VARCHAR(20) DEFAULT 'pending',
        linked_at      VARCHAR(64)
    )''')

    conn.commit()

    # ── Safe column additions for tables that may already exist on disk ──────
    # ADD COLUMN IF NOT EXISTS is idempotent — safe to run on every startup.
    for stmt in [
        # cards: new wallet columns (may not exist on older databases)
        "ALTER TABLE cards ADD COLUMN IF NOT EXISTS cardholder_name TEXT",
        "ALTER TABLE cards ADD COLUMN IF NOT EXISTS expiry          TEXT",
        "ALTER TABLE cards ADD COLUMN IF NOT EXISTS nickname        TEXT",
    ]:
        try:
            c.execute(stmt); conn.commit()
        except Exception as ex:
            conn.rollback()
            print(f"[init_db] column already present, skipping: {ex}")

    release_pg_conn(conn)
    print("✅ Database initialized successfully.")


# ---------- REWARDS SERVICE ----------
def log_late_payment(account, reason, due_date):
    conn = get_pg_conn(); c = conn.cursor()
    c.execute(
        "INSERT INTO late_payments(account_number, reason, due_date, paid_on) VALUES (%s, %s, %s, %s)",
        (account, reason, due_date, datetime.now().date().isoformat())
    )
    conn.commit(); release_pg_conn(conn)


def get_points(account):
    conn = get_pg_conn(); c = conn.cursor()
    c.execute("SELECT points FROM rewards WHERE account_number=%s", (account,))
    row = c.fetchone(); release_pg_conn(conn)
    return row['points'] if row else 0


def add_points(account, points, reason=None):
    conn = get_pg_conn(); c = conn.cursor()
    # INSERT OR IGNORE → INSERT ... ON CONFLICT DO NOTHING
    c.execute(
        "INSERT INTO rewards(account_number, points) VALUES (%s, 0) ON CONFLICT DO NOTHING",
        (account,)
    )
    c.execute(
        "UPDATE rewards SET points = points + %s WHERE account_number = %s",
        (points, account)
    )
    conn.commit(); release_pg_conn(conn)
    return get_points(account)


def redeem_points(account, cost):
    pts = get_points(account)
    if pts < cost:
        return False, pts
    conn = get_pg_conn(); c = conn.cursor()
    c.execute(
        "UPDATE rewards SET points = points - %s WHERE account_number = %s",
        (cost, account)
    )
    conn.commit()
    release_pg_conn(conn)
    new_pts = get_points(account)
    return True, new_pts


# ---------- BILLS SERVICE ----------
REMINDER_BUCKETS = {7: "due_soon", 3: "due_soon", 1: "due_soon", 0: "due_today", -1: "overdue", -3: "overdue"}


def add_bill(account, biller, amount, due_date, ref=None):
    conn = get_pg_conn(); c = conn.cursor()
    c.execute("""
        INSERT INTO bills(account_number, biller, amount, due_date, status, paid_on, ref, created_at)
        VALUES (%s, %s, %s, %s, 'unpaid', NULL, %s, %s)
        RETURNING id
    """, (account, biller, float(amount), due_date, ref, datetime.utcnow().isoformat()))
    bill_id = c.fetchone()['id']
    conn.commit(); release_pg_conn(conn)
    return bill_id


def save_paid_bill_ref(account, biller, amount, ref):
    """
    Records a bill paid directly through the dashboard's Pay Bill flow into
    the bills table, already marked 'paid', so the reference number can be
    surfaced later by get_saved_biller_ref for the 'previously saved account'
    prompt. Never shows up in list_pending() or generate_reminders() since
    those filter on status='unpaid'.
    No-op if ref is empty.
    """
    if not ref:
        return None
    today = date.today().isoformat()
    conn = get_pg_conn(); c = conn.cursor()
    c.execute("""
        INSERT INTO bills(account_number, biller, amount, due_date, status, paid_on, ref, created_at)
        VALUES (%s, %s, %s, %s, 'paid', %s, %s, %s)
        RETURNING id
    """, (account, biller, float(amount), today, today, ref, datetime.utcnow().isoformat()))
    bill_id = c.fetchone()['id']
    conn.commit(); release_pg_conn(conn)
    return bill_id


def mark_paid(account, bill_id=None, biller=None, due_date=None, paid_on=None):
    if paid_on is None:
        paid_on = date.today().isoformat()
    conn = get_pg_conn(); c = conn.cursor()
    if bill_id:
        c.execute(
            "UPDATE bills SET status='paid', paid_on=%s WHERE id=%s AND account_number=%s",
            (paid_on, bill_id, account)
        )
    else:
        c.execute("""
            UPDATE bills SET status='paid', paid_on=%s
            WHERE account_number=%s AND biller=%s AND due_date=%s AND status='unpaid'
        """, (paid_on, account, biller, due_date))
    conn.commit(); changed = c.rowcount; release_pg_conn(conn)
    return changed > 0


def list_pending(account, within_days=30, today=None):
    if today is None:
        today = date.today()
    conn = get_pg_conn(); c = conn.cursor()
    c.execute(
        "SELECT id, biller, amount, due_date FROM bills WHERE account_number=%s AND status='unpaid'",
        (account,)
    )
    rows = c.fetchall(); release_pg_conn(conn)
    out = []
    for row in rows:
        d         = datetime.strptime(row['due_date'], "%Y-%m-%d").date()
        days_left = (d - today).days
        if days_left <= within_days:
            out.append({
                "bill_id":  row['id'],
                "biller":   row['biller'],
                "amount":   float(row['amount']),
                "due_date": row['due_date'],
                "days_left": days_left
            })
    return out


# ---------- REMINDERS ----------
def _reminder_already_sent(c, bill_id, kind, on_date_iso):
    c.execute("""
        SELECT 1 FROM reminders_log
        WHERE bill_id=%s AND kind=%s AND DATE(created_at)=%s
    """, (bill_id, kind, on_date_iso))
    return c.fetchone() is not None


def _build_message(biller, amount, due_date, days_left, kind):
    amount = int(amount) if float(amount).is_integer() else amount
    if kind == "due_today":
        return f"{biller} bill of PKR {amount} is due today ({due_date}). Pay now to avoid late fee and earn points."
    if kind == "overdue":
        return f"{biller} bill of PKR {amount} is OVERDUE (due {due_date}). Please pay; late payments do not earn reward points."
    return f"{biller} bill of PKR {amount} is due in {days_left} day(s) on {due_date}. Pay on time to earn reward points."


def generate_reminders(today_str=None):
    today = datetime.strptime(today_str, "%Y-%m-%d").date() if today_str else date.today()
    conn  = get_pg_conn(); c = conn.cursor()
    c.execute("SELECT id, account_number, biller, amount, due_date FROM bills WHERE status='unpaid'")
    rows = c.fetchall(); out = []
    for row in rows:
        bill_id   = row['id']
        acc       = row['account_number']
        biller    = row['biller']
        amt       = float(row['amount'])
        due       = row['due_date']
        d         = datetime.strptime(due, "%Y-%m-%d").date()
        days_left = (d - today).days
        if days_left in REMINDER_BUCKETS:
            kind = REMINDER_BUCKETS[days_left]
            msg  = _build_message(biller, amt, due, days_left, kind)
            if not _reminder_already_sent(c, bill_id, kind, today.isoformat()):
                c.execute("""
                    INSERT INTO reminders_log
                        (account_number, bill_id, kind, message, due_date, days_left, created_at)
                    VALUES (%s, %s, %s, %s, %s, %s, %s)
                """, (acc, bill_id, kind, msg, due, days_left, datetime.utcnow().isoformat()))
            out.append({
                "account":  acc, "bill_id": bill_id, "kind": kind,
                "message":  msg, "due_date": due,    "days_left": days_left
            })
    conn.commit(); release_pg_conn(conn)
    return out


def get_inbox(account, limit=100):
    conn = get_pg_conn(); c = conn.cursor()
    c.execute("""
        SELECT bill_id, kind, message, due_date, days_left, created_at
        FROM reminders_log
        WHERE account_number=%s
        ORDER BY created_at DESC
        LIMIT %s
    """, (account, limit))
    rows = c.fetchall(); release_pg_conn(conn)
    return [{
        "bill_id":    r['bill_id'],
        "kind":       r['kind'],
        "message":    r['message'],
        "due_date":   r['due_date'],
        "days_left":  r['days_left'],
        "created_at": r['created_at']
    } for r in rows]


def detect_anomalies(account):
    conn = get_pg_conn(); c = conn.cursor(); anomalies = []
    c.execute(
        "SELECT id, biller, amount, due_date FROM bills WHERE account_number=%s AND status='unpaid'",
        (account,)
    )
    bills = c.fetchall()
    for row in bills:
        bill_id = row['id']
        biller  = row['biller']
        amount  = float(row['amount'])
        due     = row['due_date']

        # new biller?
        c.execute(
            "SELECT COUNT(*) AS cnt FROM bills WHERE account_number=%s AND biller=%s AND status='paid'",
            (account, biller)
        )
        if c.fetchone()['cnt'] == 0:
            anomalies.append({
                "bill_id": bill_id, "type": "new_biller", "biller": biller, "amount": amount,
                "message": f"First time seeing biller '{biller}'."
            })

        # amount spike?
        c.execute("""
            SELECT amount FROM bills
            WHERE account_number=%s AND biller=%s AND status='paid'
            ORDER BY paid_on DESC LIMIT 3
        """, (account, biller))
        hist = [float(r['amount']) for r in c.fetchall()]
        if hist:
            avg = sum(hist) / len(hist)
            if amount > avg * 1.5:
                anomalies.append({
                    "bill_id": bill_id, "type": "amount_spike", "biller": biller,
                    "amount": amount, "avg": round(avg, 2),
                    "message": f"Bill PKR {amount} is high vs avg PKR {round(avg, 2)}."
                })

        # duplicate?
        c.execute("""
            SELECT COUNT(*) AS cnt FROM bills
            WHERE account_number=%s AND biller=%s AND amount=%s
              AND due_date=%s AND status='unpaid' AND id<>%s
        """, (account, biller, amount, due, bill_id))
        if c.fetchone()['cnt'] > 0:
            anomalies.append({
                "bill_id": bill_id, "type": "duplicate_bill", "biller": biller, "amount": amount,
                "message": "Duplicate unpaid bill detected."
            })

    release_pg_conn(conn)
    return anomalies


# ---------- HANDOFF SERVICE ----------
def create_ticket(account, reason, meta=None):
    conn = get_pg_conn(); c = conn.cursor()
    c.execute("""
        INSERT INTO handoff_queue(account_number, reason, status, created_at)
        VALUES (%s, %s, 'pending', %s)
        RETURNING id
    """, (account, reason, datetime.utcnow().isoformat()))
    ticket_id = c.fetchone()['id']

    # put conversation in human mode (unassigned yet)
    c.execute("""
        INSERT INTO conversation_state(account_number, mode, assigned_to, updated_at)
        VALUES (%s, 'human', NULL, %s)
        ON CONFLICT(account_number) DO UPDATE SET
            mode='human', assigned_to=NULL, updated_at=EXCLUDED.updated_at
    """, (account, datetime.utcnow().isoformat()))

    conn.commit(); release_pg_conn(conn)
    return ticket_id


def queue_list(status='pending', limit=50):
    conn = get_pg_conn(); c = conn.cursor()
    c.execute("""
        SELECT id, account_number, reason, status, created_at
        FROM handoff_queue
        WHERE status=%s
        ORDER BY created_at ASC
        LIMIT %s
    """, (status, limit))
    rows = c.fetchall(); release_pg_conn(conn)
    return [{"id": r['id'], "account": r['account_number'], "reason": r['reason'],
             "status": r['status'], "created_at": r['created_at']} for r in rows]


def claim(ticket_id, banker_id):
    conn = get_pg_conn(); c = conn.cursor()
    c.execute(
        "UPDATE handoff_queue SET status='in_progress' WHERE id=%s AND status='pending'",
        (ticket_id,)
    )
    if c.rowcount == 0:
        release_pg_conn(conn); return False

    c.execute("SELECT account_number FROM handoff_queue WHERE id=%s", (ticket_id,))
    acc = c.fetchone()['account_number']

    c.execute("""
        INSERT INTO conversation_state(account_number, mode, assigned_to, updated_at)
        VALUES (%s, 'human', %s, %s)
        ON CONFLICT(account_number) DO UPDATE SET
            mode='human', assigned_to=EXCLUDED.assigned_to, updated_at=EXCLUDED.updated_at
    """, (acc, banker_id, datetime.utcnow().isoformat()))

    conn.commit(); release_pg_conn(conn)
    return True


def resolve(ticket_id):
    conn = get_pg_conn(); c = conn.cursor()
    c.execute("UPDATE handoff_queue SET status='resolved' WHERE id=%s", (ticket_id,))

    c.execute("SELECT account_number FROM handoff_queue WHERE id=%s", (ticket_id,))
    row = c.fetchone()
    if row:
        acc = row['account_number']
        c.execute("""
            INSERT INTO conversation_state(account_number, mode, assigned_to, updated_at)
            VALUES (%s, 'bot', NULL, %s)
            ON CONFLICT(account_number) DO UPDATE SET
                mode='bot', assigned_to=NULL, updated_at=EXCLUDED.updated_at
        """, (acc, datetime.utcnow().isoformat()))

    conn.commit(); release_pg_conn(conn)
    return True


def cancel(ticket_id):
    conn = get_pg_conn(); c = conn.cursor()
    c.execute("UPDATE handoff_queue SET status='canceled' WHERE id=%s", (ticket_id,))

    c.execute("SELECT account_number FROM handoff_queue WHERE id=%s", (ticket_id,))
    row = c.fetchone()
    if row:
        acc = row['account_number']
        c.execute("""
            INSERT INTO conversation_state(account_number, mode, assigned_to, updated_at)
            VALUES (%s, 'bot', NULL, %s)
            ON CONFLICT(account_number) DO UPDATE SET
                mode='bot', assigned_to=NULL, updated_at=EXCLUDED.updated_at
        """, (acc, datetime.utcnow().isoformat()))

    conn.commit(); release_pg_conn(conn)
    return True


def status(account):
    conn = get_pg_conn(); c = conn.cursor()
    c.execute(
        "SELECT mode, assigned_to, updated_at FROM conversation_state WHERE account_number=%s",
        (account,)
    )
    row = c.fetchone(); release_pg_conn(conn)
    if not row:
        return {"mode": "bot", "assigned_to": None}
    return {"mode": row['mode'], "assigned_to": row['assigned_to'], "updated_at": row['updated_at']}


# ---------- EMERGENCY ----------
def lock_all_cards(account):
    conn = get_pg_conn(); c = conn.cursor()
    c.execute("UPDATE cards SET status='locked' WHERE account_number=%s", (account,))
    conn.commit(); release_pg_conn(conn)
    return True


def alert_fraud_team(account, message):
    conn = get_pg_conn(); c = conn.cursor()
    c.execute(
        "INSERT INTO fraud_alerts(account_number, message, created_at) VALUES (%s, %s, %s)",
        (account, message, datetime.utcnow().isoformat())
    )
    conn.commit(); release_pg_conn(conn)


def safety_guide():
    return [
        "✅ All cards locked for your safety.",
        "🚨 Fraud team has been alerted.",
        "📞 Please call customer support to verify your identity."
    ]


def trigger_emergency(account, password, entered_password):
    if password != entered_password:
        return {"success": False, "message": "Incorrect password!"}
    lock_all_cards(account)
    alert_fraud_team(account, "Emergency mode triggered by user.")
    guide = safety_guide()
    return {"success": True, "steps": guide}


# ---------- CARDS SERVICE ----------
def has_registered_card(account):
    """
    Checks whether the given account has at least one card on file.
    Used to conditionally show/hide the Emergency button on the frontend.
    """
    conn = get_pg_conn(); c = conn.cursor()
    c.execute("SELECT COUNT(*) AS cnt FROM cards WHERE account_number=%s", (account,))
    count = c.fetchone()['cnt']; release_pg_conn(conn)
    return count > 0


def list_cards(account):
    """
    Returns all cards registered to an account (id, masked card number, status).
    Card numbers are masked so raw PANs never leave the backend unnecessarily.
    """
    conn = get_pg_conn(); c = conn.cursor()
    c.execute(
        "SELECT id, card_number, status FROM cards WHERE account_number=%s",
        (account,)
    )
    rows = c.fetchall(); release_pg_conn(conn)
    out = []
    for row in rows:
        card_number = row['card_number']
        masked      = f"**** **** **** {card_number[-4:]}" if card_number and len(card_number) >= 4 else "****"
        out.append({"card_id": row['id'], "card_number_masked": masked, "status": row['status']})
    return out


# ---------- BILL PROVIDERS ----------
BILL_PROVIDERS = {
    'electricity': ['K-Electric', 'LESCO', 'MEPCO', 'HESCO'],
    'internet':    ['PTCL', 'Transworld', 'Stormfiber', 'Nayatel'],
    'gas':         ['SSGC', 'SNGPL'],
}


def validate_provider(category, provider_name):
    """
    Checks whether a provider name belongs to the given utility category.
    Comparison is case-insensitive; returns canonical casing if valid, None otherwise.
    e.g. validate_provider('electricity', 'k-electric') → 'K-Electric'
    """
    providers = BILL_PROVIDERS.get(category.lower(), [])
    for p in providers:
        if p.lower() == provider_name.lower():
            return p
    return None


def get_saved_biller_ref(account, provider):
    """
    Looks up the most recently used billing reference number for a provider.
    Used for the MoM 'proactive saved account' prompt.
    Returns the ref string if found, None if no history.
    """
    conn = get_pg_conn(); c = conn.cursor()
    c.execute("""
        SELECT ref FROM bills
        WHERE account_number=%s AND biller=%s AND ref IS NOT NULL
        ORDER BY created_at DESC
        LIMIT 1
    """, (account, provider))
    row = c.fetchone(); release_pg_conn(conn)
    return row['ref'] if row else None


# ---------- REDEMPTION TIERS ----------
REDEMPTION_TIERS = {
    'cash_voucher':      {'points_cost': 500,  'pkr_value': 250},
    'product_purchase':  {'points_cost': 1000, 'pkr_value': 500},
    'investment_pocket': {'points_cost': 750,  'pkr_value': 375},
}

MOCK_PRODUCT_CATALOGUE = {
    'P001': {'name': 'FinBud Prepaid Mobile Recharge', 'pkr_value': 200},
    'P002': {'name': 'FinBud Shopping Gift Voucher',   'pkr_value': 500},
    'P003': {'name': 'FinBud Utility Bill Discount',   'pkr_value': 300},
}


def get_product(product_id):
    """Returns product details from the mock catalogue by ID, or None."""
    return MOCK_PRODUCT_CATALOGUE.get(product_id)


def get_redemption_tier(tier_name):
    """Returns the config dict for a redemption tier, or None if invalid."""
    return REDEMPTION_TIERS.get(tier_name)


# ══════════════════════════════════════════════════════════════════════════════
# v3  — Financial Advisor + Digital Wallet backend
# Added: 22 June 2026  |  Handoff doc: FinBud_Backend_Handoff_v3.docx
# ══════════════════════════════════════════════════════════════════════════════

# ---------- INCOME SERVICE ----------
def get_income_vs_expense(account):
    """
    Returns this calendar month's total income, total expenses, and net
    for the given account.

    • income   — summed from income_transactions
    • expenses — summed from dashboard_transactions where amount < 0
    • net      — income − expenses
    """
    conn = get_pg_conn(); c = conn.cursor()

    # First day of the current UTC calendar month as an ISO string.
    # Because created_at is stored as ISO text (e.g. "2026-06-22T10:30:00"),
    # a simple string comparison >= month_start is lexicographically correct.
    now         = datetime.utcnow()
    month_start = datetime(now.year, now.month, 1).isoformat()

    c.execute("""
        SELECT COALESCE(SUM(amount), 0) AS total
        FROM income_transactions
        WHERE account_number=%s AND created_at >= %s
    """, (account, month_start))
    income = float(c.fetchone()['total'])

    c.execute("""
        SELECT COALESCE(SUM(ABS(amount)), 0) AS total
        FROM dashboard_transactions
        WHERE account_number=%s AND amount < 0 AND created_at >= %s
    """, (account, month_start))
    expenses = float(c.fetchone()['total'])

    release_pg_conn(conn)
    return {
        'income':   round(income, 2),
        'expenses': round(expenses, 2),
        'net':      round(income - expenses, 2)
    }


def get_income_by_source(account):
    """
    Returns this calendar month's income grouped by source.
    Response shape: { "Salary": 50000.0, "Rental Income": 20000.0, ... }
    """
    conn = get_pg_conn(); c = conn.cursor()

    now         = datetime.utcnow()
    month_start = datetime(now.year, now.month, 1).isoformat()

    c.execute("""
        SELECT source, COALESCE(SUM(amount), 0) AS total
        FROM income_transactions
        WHERE account_number=%s AND created_at >= %s
        GROUP BY source
        ORDER BY total DESC
    """, (account, month_start))
    rows = c.fetchall(); release_pg_conn(conn)
    return {r['source']: round(float(r['total']), 2) for r in rows}


def get_monthly_trend(account, months=6):
    """
    Returns income vs. expenses for the last N complete calendar months.
    Used by the Monthly Trend bar chart in the Financial Advisor panel.

    Response shape:
        [{"month": "Jan 26", "income": 50000.0, "expenses": 30000.0}, ...]
    """
    conn = get_pg_conn(); c = conn.cursor()

    # Calculate the cutoff date in pure Python to avoid SQL INTERVAL
    # parameterization quirks in psycopg2.
    today = datetime.utcnow()
    cutoff_month = today.month - months
    cutoff_year  = today.year
    while cutoff_month <= 0:
        cutoff_month += 12
        cutoff_year  -= 1
    cutoff_iso = datetime(cutoff_year, cutoff_month, 1).isoformat()

    # Income per month — cast stored ISO text to timestamp for DATE_TRUNC
    c.execute("""
        SELECT
            TO_CHAR(DATE_TRUNC('month', created_at::timestamp), 'Mon YY') AS month,
            COALESCE(SUM(amount), 0) AS income
        FROM income_transactions
        WHERE account_number=%s AND created_at >= %s
        GROUP BY DATE_TRUNC('month', created_at::timestamp)
        ORDER BY DATE_TRUNC('month', created_at::timestamp)
    """, (account, cutoff_iso))
    income_map = {r['month']: round(float(r['income']), 2) for r in c.fetchall()}

    # Expenses per month from dashboard_transactions (negative amounts)
    c.execute("""
        SELECT
            TO_CHAR(DATE_TRUNC('month', created_at::timestamp), 'Mon YY') AS month,
            COALESCE(SUM(ABS(amount)), 0) AS expenses
        FROM dashboard_transactions
        WHERE account_number=%s AND amount < 0 AND created_at >= %s
        GROUP BY DATE_TRUNC('month', created_at::timestamp)
        ORDER BY DATE_TRUNC('month', created_at::timestamp)
    """, (account, cutoff_iso))
    expense_map = {r['month']: round(float(r['expenses']), 2) for r in c.fetchall()}

    release_pg_conn(conn)

    # Merge both sets of months in chronological order
    all_months = sorted(set(list(income_map.keys()) + list(expense_map.keys())))
    return [
        {
            'month':    m,
            'income':   income_map.get(m, 0),
            'expenses': expense_map.get(m, 0)
        }
        for m in all_months
    ]
