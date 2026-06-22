# features.py
import sqlite3
from datetime import datetime, date

DB = 'FinBudAi.db'

# ---------- DATABASE INIT ----------
def init_db():
    conn = sqlite3.connect(DB)
    c = conn.cursor()

    # users
    c.execute('''
    CREATE TABLE IF NOT EXISTS users(
      account_number TEXT PRIMARY KEY,
      name TEXT,
      phone TEXT,
      language TEXT
    )''')

    # transactions
    c.execute('''
    CREATE TABLE IF NOT EXISTS transactions(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_number TEXT,
      date TEXT,
      description TEXT,
      amount REAL
    )''')

    # rewards
    c.execute('''
    CREATE TABLE IF NOT EXISTS rewards(
      account_number TEXT PRIMARY KEY,
      points INTEGER DEFAULT 0
    )''')

    # reminders
    c.execute('''
    CREATE TABLE IF NOT EXISTS reminders(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_number TEXT,
      bill_type TEXT,
      due_date TEXT,
      amount REAL,
      sent INTEGER DEFAULT 0
    )''')

    # handoff queue
    c.execute('''
    CREATE TABLE IF NOT EXISTS handoff_queue(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_number TEXT,
      reason TEXT,
      status TEXT DEFAULT 'pending',
      created_at TEXT
    )''')

    # late payments
    c.execute('''
    CREATE TABLE IF NOT EXISTS late_payments(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_number TEXT,
      reason TEXT,
      due_date TEXT,
      paid_on TEXT
    )''')

    # Bills table
    c.execute('''
    CREATE TABLE IF NOT EXISTS bills(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_number TEXT,
      biller TEXT,
      amount REAL,
      due_date TEXT,
      status TEXT DEFAULT 'unpaid',
      paid_on TEXT,
      ref TEXT,
      created_at TEXT
    )''')

    # Reminders log
    c.execute('''
    CREATE TABLE IF NOT EXISTS reminders_log(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_number TEXT,
      bill_id INTEGER,
      kind TEXT,
      message TEXT,
      due_date TEXT,
      days_left INTEGER,
      created_at TEXT
    )''')

    # Conversation state
    c.execute('''
    CREATE TABLE IF NOT EXISTS conversation_state(
      account_number TEXT PRIMARY KEY,
      mode TEXT DEFAULT 'bot',
      assigned_to TEXT,
      updated_at TEXT
    )''')

    # Cards table
    c.execute('''
    CREATE TABLE IF NOT EXISTS cards(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_number TEXT,
      card_number TEXT,
      status TEXT DEFAULT 'active'
    )''')

    # Fraud alerts
    c.execute('''
    CREATE TABLE IF NOT EXISTS fraud_alerts(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_number TEXT,
      message TEXT,
      created_at TEXT
    )''')

    conn.commit()
    conn.close()
    print("✅ Database initialized successfully.")


# ---------- HELPER ----------
def _conn():
    return sqlite3.connect(DB)


# ---------- REWARDS SERVICE ----------
def log_late_payment(account, reason, due_date):
    conn = _conn(); c = conn.cursor()
    c.execute("INSERT INTO late_payments(account_number, reason, due_date, paid_on) VALUES (?, ?, ?, ?)",
              (account, reason, due_date, datetime.now().date().isoformat()))
    conn.commit(); conn.close()

def get_points(account):
    conn = _conn(); c = conn.cursor()
    c.execute("SELECT points FROM rewards WHERE account_number=?", (account,))
    row = c.fetchone(); conn.close()
    return row[0] if row else 0

def add_points(account, points, reason=None):
    conn = _conn(); c = conn.cursor()
    c.execute("INSERT OR IGNORE INTO rewards(account_number, points) VALUES (?, ?)", (account, 0))
    c.execute("UPDATE rewards SET points = points + ? WHERE account_number = ?", (points, account))
    conn.commit(); conn.close()
    return get_points(account)

def redeem_points(account, cost):
    pts = get_points(account)
    if pts < cost:
        return False, pts
    conn = _conn(); c = conn.cursor()
    c.execute("UPDATE rewards SET points = points - ? WHERE account_number = ?", (cost, account))
    conn.commit(); new_pts = get_points(account); conn.close()
    return True, new_pts


# ---------- BILLS SERVICE ----------
REMINDER_BUCKETS = {7: "due_soon", 3: "due_soon", 1: "due_soon", 0: "due_today", -1: "overdue", -3: "overdue"}

def add_bill(account, biller, amount, due_date, ref=None):
    conn = _conn(); c = conn.cursor()
    c.execute("""INSERT INTO bills(account_number, biller, amount, due_date, status, paid_on, ref, created_at)
                 VALUES (?, ?, ?, ?, 'unpaid', NULL, ?, ?)""",
              (account, biller, float(amount), due_date, ref, datetime.utcnow().isoformat()))
    conn.commit(); bill_id = c.lastrowid; conn.close()
    return bill_id

def mark_paid(account, bill_id=None, biller=None, due_date=None, paid_on=None):
    if paid_on is None: paid_on = date.today().isoformat()
    conn = _conn(); c = conn.cursor()
    if bill_id:
        c.execute("UPDATE bills SET status='paid', paid_on=? WHERE id=? AND account_number=?",
                  (paid_on, bill_id, account))
    else:
        c.execute("""UPDATE bills SET status='paid', paid_on=?
                     WHERE account_number=? AND biller=? AND due_date=? AND status='unpaid'""",
                  (paid_on, account, biller, due_date))
    conn.commit(); changed = c.rowcount; conn.close()
    return changed > 0

def list_pending(account, within_days=30, today=None):
    if today is None: today = date.today()
    conn = _conn(); c = conn.cursor()
    c.execute("SELECT id, biller, amount, due_date FROM bills WHERE account_number=? AND status='unpaid'", (account,))
    rows = c.fetchall(); conn.close()
    out = []
    for bid, biller, amt, due in rows:
        d = datetime.strptime(due, "%Y-%m-%d").date()
        days_left = (d - today).days
        if days_left <= within_days:
            out.append({"bill_id": bid, "biller": biller, "amount": amt, "due_date": due, "days_left": days_left})
    return out


# ---------- REMINDERS ----------
def _reminder_already_sent(c, bill_id, kind, on_date_iso):
    c.execute("""SELECT 1 FROM reminders_log
                 WHERE bill_id=? AND kind=? AND DATE(created_at)=?""",
              (bill_id, kind, on_date_iso))
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
    conn = _conn(); c = conn.cursor()
    c.execute("SELECT id, account_number, biller, amount, due_date FROM bills WHERE status='unpaid'")
    rows = c.fetchall(); out = []
    for bill_id, acc, biller, amt, due in rows:
        d = datetime.strptime(due, "%Y-%m-%d").date()
        days_left = (d - today).days
        if days_left in REMINDER_BUCKETS:
            kind = REMINDER_BUCKETS[days_left]
            msg = _build_message(biller, amt, due, days_left, kind)
            if not _reminder_already_sent(c, bill_id, kind, today.isoformat()):
                c.execute("""INSERT INTO reminders_log(account_number, bill_id, kind, message, due_date, days_left, created_at)
                             VALUES (?, ?, ?, ?, ?, ?, ?)""",
                          (acc, bill_id, kind, msg, due, days_left, datetime.utcnow().isoformat()))
            out.append({"account": acc, "bill_id": bill_id, "kind": kind, "message": msg, "due_date": due, "days_left": days_left})
    conn.commit(); conn.close()
    return out

def get_inbox(account, limit=100):
    conn = _conn(); c = conn.cursor()
    c.execute("""SELECT bill_id, kind, message, due_date, days_left, created_at
                 FROM reminders_log WHERE account_number=? ORDER BY created_at DESC LIMIT ?""", (account, limit))
    rows = c.fetchall(); conn.close()
    return [{"bill_id": r[0], "kind": r[1], "message": r[2], "due_date": r[3], "days_left": r[4], "created_at": r[5]} for r in rows]

def detect_anomalies(account):
    conn = _conn(); c = conn.cursor(); anomalies = []
    c.execute("""SELECT id, biller, amount, due_date FROM bills WHERE account_number=? AND status='unpaid'""", (account,))
    bills = c.fetchall()
    for bill_id, biller, amount, due in bills:
        # new biller?
        c.execute("""SELECT COUNT(*) FROM bills WHERE account_number=? AND biller=? AND status='paid'""", (account, biller))
        if c.fetchone()[0] == 0:
            anomalies.append({"bill_id": bill_id, "type": "new_biller", "biller": biller, "amount": amount,
                              "message": f"First time seeing biller '{biller}'."})
        # amount spike?
        c.execute("""SELECT amount FROM bills WHERE account_number=? AND biller=? AND status='paid'
                     ORDER BY paid_on DESC LIMIT 3""", (account, biller))
        hist = [r[0] for r in c.fetchall()]
        if hist:
            avg = sum(hist) / len(hist)
            if amount > avg * 1.5:
                anomalies.append({"bill_id": bill_id, "type": "amount_spike", "biller": biller,
                                  "amount": amount, "avg": round(avg, 2),
                                  "message": f"Bill PKR {amount} is high vs avg PKR {round(avg,2)}."})
        # duplicate?
        c.execute("""SELECT COUNT(*) FROM bills WHERE account_number=? AND biller=? AND amount=? AND due_date=? AND status='unpaid' AND id<>?""",
                  (account, biller, amount, due, bill_id))
        if c.fetchone()[0] > 0:
            anomalies.append({"bill_id": bill_id, "type": "duplicate_bill", "biller": biller, "amount": amount,
                              "message": "Duplicate unpaid bill detected."})
    conn.close(); return anomalies

# ---------- HANDOFF SERVICE ----------
def create_ticket(account, reason, meta=None):
    conn = _conn(); c = conn.cursor()
    c.execute(
        "INSERT INTO handoff_queue(account_number, reason, status, created_at) VALUES (?, ?, 'pending', ?)",
        (account, reason, datetime.utcnow().isoformat())
    )
    ticket_id = c.lastrowid

    # put conversation in human mode (unassigned yet)
    c.execute("""
        INSERT INTO conversation_state(account_number, mode, assigned_to, updated_at)
        VALUES (?, 'human', NULL, ?)
        ON CONFLICT(account_number) DO UPDATE SET
          mode='human', assigned_to=NULL, updated_at=excluded.updated_at
    """, (account, datetime.utcnow().isoformat()))

    conn.commit(); conn.close()
    return ticket_id

def queue_list(status='pending', limit=50):
    conn = _conn(); c = conn.cursor()
    c.execute("""SELECT id, account_number, reason, status, created_at
                 FROM handoff_queue
                 WHERE status=?
                 ORDER BY created_at ASC
                 LIMIT ?""", (status, limit))
    rows = c.fetchall()
    conn.close()
    return [
        {"id": r[0], "account": r[1], "reason": r[2], "status": r[3], "created_at": r[4]}
        for r in rows
    ]

def claim(ticket_id, banker_id):
    conn = _conn(); c = conn.cursor()
    # mark ticket in-progress
    c.execute("UPDATE handoff_queue SET status='in_progress' WHERE id=? AND status='pending'", (ticket_id,))
    if c.rowcount == 0:
        conn.close()
        return False

    # find account to set assignment
    c.execute("SELECT account_number FROM handoff_queue WHERE id=?", (ticket_id,))
    acc = c.fetchone()[0]

    # assign banker + keep human mode
    c.execute("""
      INSERT INTO conversation_state(account_number, mode, assigned_to, updated_at)
      VALUES (?, 'human', ?, ?)
      ON CONFLICT(account_number) DO UPDATE SET
         mode='human', assigned_to=excluded.assigned_to, updated_at=excluded.updated_at
    """, (acc, banker_id, datetime.utcnow().isoformat()))

    conn.commit(); conn.close()
    return True

def resolve(ticket_id):
    conn = _conn(); c = conn.cursor()
    c.execute("UPDATE handoff_queue SET status='resolved' WHERE id=?", (ticket_id,))

    # back to bot mode
    c.execute("SELECT account_number FROM handoff_queue WHERE id=?", (ticket_id,))
    row = c.fetchone()
    if row:
        acc = row[0]
        c.execute("""
          INSERT INTO conversation_state(account_number, mode, assigned_to, updated_at)
          VALUES (?, 'bot', NULL, ?)
          ON CONFLICT(account_number) DO UPDATE SET
             mode='bot', assigned_to=NULL, updated_at=excluded.updated_at
        """, (acc, datetime.utcnow().isoformat()))

    conn.commit(); conn.close()
    return True

def cancel(ticket_id):
    conn = _conn(); c = conn.cursor()
    c.execute("UPDATE handoff_queue SET status='canceled' WHERE id=?", (ticket_id,))
    # back to bot if we know the account
    c.execute("SELECT account_number FROM handoff_queue WHERE id=?", (ticket_id,))
    row = c.fetchone()
    if row:
        acc = row[0]
        c.execute("""
          INSERT INTO conversation_state(account_number, mode, assigned_to, updated_at)
          VALUES (?, 'bot', NULL, ?)
          ON CONFLICT(account_number) DO UPDATE SET
             mode='bot', assigned_to=NULL, updated_at=excluded.updated_at
        """, (acc, datetime.utcnow().isoformat()))
    conn.commit(); conn.close()
    return True

def status(account):
    conn = _conn(); c = conn.cursor()
    c.execute("SELECT mode, assigned_to, updated_at FROM conversation_state WHERE account_number=?", (account,))
    row = c.fetchone(); conn.close()
    if not row:
        return {"mode": "bot", "assigned_to": None}
    return {"mode": row[0], "assigned_to": row[1], "updated_at": row[2]}

# ---------- EMERGENCY ----------
def lock_all_cards(account):
    conn = _conn(); c = conn.cursor()
    c.execute("UPDATE cards SET status='locked' WHERE account_number=?", (account,))
    conn.commit(); conn.close(); return True

def alert_fraud_team(account, message):
    conn = _conn(); c = conn.cursor()
    c.execute("INSERT INTO fraud_alerts(account_number, message, created_at) VALUES (?, ?, ?)",
              (account, message, datetime.utcnow().isoformat()))
    conn.commit(); conn.close()

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

# ---------- CARDS SERVICE (Emergency Feature) ----------
def has_registered_card(account):
    """
    Checks whether the given account has at least one card on file.
    Used to conditionally show/hide the Emergency button on the frontend.
    """
    conn = _conn(); c = conn.cursor()
    c.execute("SELECT COUNT(*) FROM cards WHERE account_number=?", (account,))
    count = c.fetchone()[0]
    conn.close()
    return count > 0


def list_cards(account):
    """
    Returns all cards registered to an account (id, masked card number, status).
    Card numbers are masked here so raw PANs never leave the backend unnecessarily.
    """
    conn = _conn(); c = conn.cursor()
    c.execute("SELECT id, card_number, status FROM cards WHERE account_number=?", (account,))
    rows = c.fetchall(); conn.close()
    out = []
    for card_id, card_number, status in rows:
        masked = f"**** **** **** {card_number[-4:]}" if card_number and len(card_number) >= 4 else "****"
        out.append({"card_id": card_id, "card_number_masked": masked, "status": status})
    return out

# ---------- BILL PROVIDERS (Service Provider Level) ----------

BILL_PROVIDERS = {
    'electricity': ['K-Electric', 'LESCO', 'MEPCO', 'HESCO'],
    'internet':    ['PTCL', 'Transworld', 'Stormfiber', 'Nayatel'],
    'gas':         ['SSGC', 'SNGPL'],
}


def validate_provider(category, provider_name):
    """
    Checks whether a given provider name belongs to the given utility category.
    Comparison is case-insensitive; returns the canonical casing if valid, None otherwise.
    e.g. validate_provider('electricity', 'k-electric') → 'K-Electric'
    """
    providers = BILL_PROVIDERS.get(category.lower(), [])
    for p in providers:
        if p.lower() == provider_name.lower():
            return p  # return correctly-cased name for storage
    return None


def get_saved_biller_ref(account, provider):
    """
    Looks up the most recently used billing reference number for this
    specific provider from the bills table.
    Used for the MoM 'proactive saved account' prompt:
    e.g. "Are you referring to your previously saved account 112233?"
    Returns the ref string if found, None if this provider has no history.
    """
    conn = _conn(); c = conn.cursor()
    c.execute("""
        SELECT ref FROM bills
        WHERE account_number=? AND biller=? AND ref IS NOT NULL
        ORDER BY created_at DESC
        LIMIT 1
    """, (account, provider))
    row = c.fetchone(); conn.close()
    return row[0] if row else None


# ---------- REDEMPTION TIERS ----------

# Defines all 3 redemption tiers: points cost and PKR value each tier gives.
REDEMPTION_TIERS = {
    'cash_voucher':      {'points_cost': 500,  'pkr_value': 250},
    'product_purchase':  {'points_cost': 1000, 'pkr_value': 500},
    'investment_pocket': {'points_cost': 750,  'pkr_value': 375},
}

# Mock product catalogue for the product_purchase tier.
# In production this would be a DB table or an external inventory API.
MOCK_PRODUCT_CATALOGUE = {
    'P001': {'name': 'FinBud Prepaid Mobile Recharge', 'pkr_value': 200},
    'P002': {'name': 'FinBud Shopping Gift Voucher',   'pkr_value': 500},
    'P003': {'name': 'FinBud Utility Bill Discount',   'pkr_value': 300},
}


def get_product(product_id):
    """
    Returns product details from the mock catalogue by product ID.
    Returns None if the product_id does not exist.
    """
    return MOCK_PRODUCT_CATALOGUE.get(product_id)


def get_redemption_tier(tier_name):
    """
    Returns the config dict for a redemption tier (points_cost, pkr_value).
    Returns None if tier_name is not one of the 3 valid options.
    """
    return REDEMPTION_TIERS.get(tier_name)