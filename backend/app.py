# app.py  –  FinBud AI  (React + Hybrid LLM + PostgreSQL COMPLETE Edition — MERGED)
# ─────────────────────────────────────────────────────────────────────────────
# This file is a full merge of two previous versions of app.py:
#
#   1. "React + Hybrid LLM Edition"
#        - Flask serves the Vite React build in production (catch-all route).
#        - flask-cors added so the Vite dev-server (port 5173) can call
#          /api without CORS errors.
#        - LLMFallback integrated for intent='general_chat', tagging every
#          LLM-assisted response with llm_used=True in the JSON payload.
#
#   2. "PostgreSQL Edition — COMPLETE"
#        - Full PostgreSQL migration (psycopg2 + connection pool,
#          RealDictCursor, %s placeholders, RETURNING id, release_db()).
#        - v3: Financial Advisor + Digital Wallet endpoints.
#        - v4: Credit Intelligence (C.I.) API.
#        - v5: Notifications, Expense Categories, transaction fee
#          calculation, detailed spending-by-category breakdown.
#
# NOTHING has been removed from either version — every route, helper,
# table, and column from both files is preserved below.
# ─────────────────────────────────────────────────────────────────────────────

from flask import (
    Flask, render_template, request, jsonify, session, redirect,
    url_for, send_from_directory
)
from flask_cors import CORS
from werkzeug.security import generate_password_hash, check_password_hash

import psycopg2
import psycopg2.extras
from psycopg2 import pool as psycopg2_pool

from dotenv import load_dotenv
load_dotenv()

from datetime import datetime, timedelta
import secrets
import sys
import os
import io
import time
import logging

from features import (
    init_db, log_late_payment, get_points, add_points, redeem_points,
    add_bill, save_paid_bill_ref, mark_paid, list_pending, generate_reminders, get_inbox,
    detect_anomalies, create_ticket, queue_list, claim, resolve, cancel,
    status, trigger_emergency, has_registered_card, list_cards,
    BILL_PROVIDERS, REDEMPTION_TIERS, MOCK_PRODUCT_CATALOGUE,
    validate_provider, get_saved_biller_ref, get_product, get_redemption_tier,
    # ── v3 additions (Financial Advisor + Digital Wallet) ─────────────────────
    get_income_vs_expense, get_income_by_source,
    get_monthly_trend, get_pg_conn, release_pg_conn,
    # ── v4 additions (Credit Intelligence) ───────────────────────────────────
    generate_credit_score
)
# ── Savings Goals feature (self-contained blueprint) ───────────────────────
from advisor_profile_routes import advisor_profile_bp, init_profile_tables
from goals_routes import goals_bp, init_goals_tables
from nlp_module import BankAIConversation

# ── Optional: speech recognition ─────────────────────────────────────────────
try:
    import speech_recognition as sr
    SPEECH_RECOGNITION_AVAILABLE = True
except ImportError:
    SPEECH_RECOGNITION_AVAILABLE = False
    print("Warning: speech_recognition not installed.")

# ── Optional: LLM fallback ────────────────────────────────────────────────────
try:
    from llm_fallback import LLMFallback, apply_confidence_gate
    LLM_AVAILABLE = True
except ImportError:
    LLM_AVAILABLE = False
    print("Warning: llm_fallback not available — running regex-only mode.")

logger = logging.getLogger(__name__)

# ─────────────────────────────────────────────────────────────────────────────
# Flask setup
# ─────────────────────────────────────────────────────────────────────────────

# Path to Vite's production build output.
# In dev the build folder won't exist — that's fine, we just serve the API.
REACT_BUILD_DIR = os.path.join(os.path.dirname(__file__), '..', 'frontend', 'dist')

app = Flask(__name__, static_folder=REACT_BUILD_DIR, static_url_path='/')
# Fixed key from env so sessions survive restarts/redeploys and stay valid
# across multiple Gunicorn workers. Falls back to a per-process random key
# (with a warning) only if SECRET_KEY isn't set, so dev still works out of
# the box — but production should always set SECRET_KEY.
app.secret_key = os.environ.get('SECRET_KEY')
if not app.secret_key:
    print("WARNING: SECRET_KEY not set in environment — using a random "
          "per-process key. Sessions will NOT survive restarts or work "
          "across multiple workers. Set SECRET_KEY for production.")
    app.secret_key = secrets.token_hex(32)

# CORS: allow the Vite dev-server (port 5173) to call the Flask API (port 5000)
# without browser CORS errors.  In production both run on the same origin so
# CORS is a no-op.
CORS(app,
     supports_credentials=True,
     origins=[
         "http://localhost:5173", "http://127.0.0.1:5173",
         "http://localhost:5174", "http://127.0.0.1:5174",   # admin console
     ])

# ── NLP engine ────────────────────────────────────────────────────────────────
chatbot = BankAIConversation()
app.register_blueprint(advisor_profile_bp)   # ← added

# ── Savings Goals feature (self-contained blueprint) ───────────────────────
app.register_blueprint(goals_bp)

# ── Grow My Money: investing guides (isolated blueprint, see investing_guide_routes.py) ──
from investing_guide_routes import investing_guide_bp
app.register_blueprint(investing_guide_bp)

# ── Admin/Ops Console blueprints (auth, overview, chat-monitor, tickets, ─────
#    transactions, users, fees, settings, fraud, activity, rewards, kyc —
#    see admin_routes/__init__.py for the full ADMIN_BLUEPRINTS list. ────────
from admin_routes import ADMIN_BLUEPRINTS
for bp in ADMIN_BLUEPRINTS:
    app.register_blueprint(bp)

# ── PostgreSQL connection pool ─────────────────────────────────────────────────
DATABASE_URL = os.getenv("DATABASE_URL")
if not DATABASE_URL:
    sys.exit("❌  DATABASE_URL not set.  Check your .env file.")

connection_pool = psycopg2_pool.ThreadedConnectionPool(
    minconn=2,
    maxconn=10,
    dsn=DATABASE_URL
)
print("✅  PostgreSQL connection pool initialised.")


def get_db():
    """
    Returns a psycopg2 connection from the pool.
    RealDictCursor makes rows behave like dicts — same as sqlite3.Row,
    so all existing row['column_name'] access works unchanged.
    """
    conn = connection_pool.getconn()
    conn.cursor_factory = psycopg2.extras.RealDictCursor
    return conn


def release_db(conn):
    """Returns the connection back to the pool instead of closing it."""
    connection_pool.putconn(conn)


# ─────────────────────────────────────────────────────────────────────────────
# Schema initialisation
# ─────────────────────────────────────────────────────────────────────────────

def init_user_tables():
    """Creates all app.py-owned tables in PostgreSQL."""
    conn = get_db()
    c = conn.cursor()

    c.execute('''
    CREATE TABLE IF NOT EXISTS dashboard_users (
        id              SERIAL PRIMARY KEY,
        account_number  VARCHAR(30)   UNIQUE NOT NULL,
        name            VARCHAR(120)  NOT NULL,
        email           VARCHAR(120)  UNIQUE NOT NULL,
        password_hash   TEXT          NOT NULL,
        phone           VARCHAR(20),
        balance         NUMERIC(15,2) DEFAULT 0,
        points          INTEGER       DEFAULT 0,
        created_at      VARCHAR(64),
        language        VARCHAR(10)   DEFAULT 'en',
        other_assets    NUMERIC(15,2) DEFAULT 0
    )''')

    c.execute('''
    CREATE TABLE IF NOT EXISTS dashboard_transactions (
        id               SERIAL PRIMARY KEY,
        account_number   VARCHAR(30),
        transaction_type VARCHAR(30),
        description      TEXT,
        amount           NUMERIC(15,2),
        recipient        VARCHAR(120),
        biller           VARCHAR(120),
        bill_id          VARCHAR(30),
        status           VARCHAR(20) DEFAULT 'completed',
        created_at       VARCHAR(64),
        category         VARCHAR(60),
        fee              NUMERIC(15,2) DEFAULT 0,
        FOREIGN KEY (account_number) REFERENCES dashboard_users(account_number)
    )''')

    c.execute('''
    CREATE TABLE IF NOT EXISTS redemptions (
        id             SERIAL PRIMARY KEY,
        account_number VARCHAR(30),
        points_used    INTEGER,
        reward_value   NUMERIC(15,2),
        created_at     VARCHAR(64),
        FOREIGN KEY (account_number) REFERENCES dashboard_users(account_number)
    )''')

    c.execute('''
    CREATE TABLE IF NOT EXISTS chat_history (
        id             SERIAL PRIMARY KEY,
        account_number VARCHAR(30),
        user_message   TEXT,
        ai_response    TEXT,
        intent         VARCHAR(60),
        created_at     VARCHAR(64),
        FOREIGN KEY (account_number) REFERENCES dashboard_users(account_number)
    )''')

    c.execute('''
    CREATE TABLE IF NOT EXISTS cards (
        id             SERIAL PRIMARY KEY,
        account_number VARCHAR(30),
        card_number    VARCHAR(20),
        status         VARCHAR(20) DEFAULT 'active'
    )''')

    c.execute('''
    CREATE TABLE IF NOT EXISTS fraud_alerts (
        id             SERIAL PRIMARY KEY,
        account_number VARCHAR(30),
        message        TEXT,
        created_at     VARCHAR(64)
    )''')

    c.execute('''
    CREATE TABLE IF NOT EXISTS notifications (
        id             SERIAL PRIMARY KEY,
        account_number VARCHAR(30),
        message        TEXT,
        notif_type     VARCHAR(30) DEFAULT 'transaction',
        is_read        BOOLEAN DEFAULT FALSE,
        created_at     VARCHAR(64)
    )''')

    conn.commit()

    # ── Safe column additions for existing databases ───────────────────────────
    for stmt in [
        "ALTER TABLE dashboard_users ADD COLUMN IF NOT EXISTS other_assets NUMERIC(15,2) DEFAULT 0",
        "ALTER TABLE dashboard_transactions ADD COLUMN IF NOT EXISTS category VARCHAR(60)",
        "ALTER TABLE dashboard_transactions ADD COLUMN IF NOT EXISTS fee NUMERIC(15,2) DEFAULT 0",
        "ALTER TABLE cards ADD COLUMN IF NOT EXISTS cardholder_name TEXT",
        "ALTER TABLE cards ADD COLUMN IF NOT EXISTS expiry TEXT",
        "ALTER TABLE cards ADD COLUMN IF NOT EXISTS nickname TEXT",
        # ── Phone + OTP + CNIC + PIN signup flow ────────────────────────────
        # email/password_hash stay as-is for existing EAM accounts; new
        # phone-based accounts use cnic/pin_hash/status/otp_* instead.
        "ALTER TABLE dashboard_users ALTER COLUMN email DROP NOT NULL",
        "ALTER TABLE dashboard_users ALTER COLUMN password_hash DROP NOT NULL",
        "ALTER TABLE dashboard_users ADD COLUMN IF NOT EXISTS cnic VARCHAR(15)",
        "ALTER TABLE dashboard_users ADD COLUMN IF NOT EXISTS pin_hash TEXT",
        "ALTER TABLE dashboard_users ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'active'",
        "ALTER TABLE dashboard_users ADD COLUMN IF NOT EXISTS otp_hash TEXT",
        "ALTER TABLE dashboard_users ADD COLUMN IF NOT EXISTS otp_expires_at TIMESTAMP",
        "ALTER TABLE dashboard_users ADD COLUMN IF NOT EXISTS otp_attempts INTEGER DEFAULT 0",
        "ALTER TABLE dashboard_users ADD COLUMN IF NOT EXISTS otp_last_sent_at TIMESTAMP",
        "ALTER TABLE dashboard_users ADD COLUMN IF NOT EXISTS otp_requests_count INTEGER DEFAULT 0",
        "ALTER TABLE dashboard_users ADD COLUMN IF NOT EXISTS otp_requests_window_started_at TIMESTAMP",
    ]:
        try:
            c.execute(stmt); conn.commit()
        except Exception as ex:
            conn.rollback()
            print(f"[init_user_tables] skipping: {ex}")

    release_db(conn)


# Initialize tables from both modules
init_user_tables()
init_db()

from admin_tables import init_admin_tables
init_admin_tables()
from admin_routes.activity import init_activity_tables
init_activity_tables()  # creates customer_login_log — without this, UserActivityLog.jsx's Login Activity tab 500s
# ── Savings Goals feature — schema init ─────────────────────────────────────
# init_goals_tables(conn) commits internally; we open/release the connection
# here ourselves (same get_pg_conn()/release_pg_conn() pattern init_db() uses)
# so it isn't leaked back to the pool.
_goals_init_conn = get_pg_conn()
init_goals_tables(_goals_init_conn)
release_pg_conn(_goals_init_conn)

_goals_init_conn = get_pg_conn()
init_profile_tables(get_pg_conn())   # ← added
release_pg_conn(_goals_init_conn)


# ─────────────────────────────────────────────────────────────────────────────
# React build serving
# ─────────────────────────────────────────────────────────────────────────────

@app.route('/', defaults={'path': ''})
@app.route('/<path:path>')
def serve_react(path):
    """
    Serve the React build for every non-API route.
    In development (no dist/ folder) this is never hit because the Vite
    dev-server handles all non-/api paths itself.
    In production (after `npm run build`) this serves index.html for every
    path, letting React Router handle client-side navigation.
    """
    # API routes are handled by their own @app.route decorators — Flask
    # matches those first, so this catch-all is only reached for frontend paths.
    dist_index = os.path.join(REACT_BUILD_DIR, 'index.html')
    if os.path.exists(dist_index):
        return send_from_directory(REACT_BUILD_DIR, 'index.html')

    # Dev mode — Vite is serving the frontend, Flask is API-only.
    return jsonify({
        'status': 'FinBud AI backend running',
        'note': 'Start the Vite dev-server with: cd frontend && npm run dev'
    }), 200


# ═══════════════════════════════════════════════════════════════════════════
# AUTHENTICATION API
# ═══════════════════════════════════════════════════════════════════════════

@app.route('/api/auth/register', methods=['POST'])
def register():
    """Legacy email/password registration path — kept as-is so nothing
    that still relies on it (e.g. EAM/admin-created accounts) breaks.
    New end-user signups go through the phone/OTP/CNIC/PIN endpoints below."""
    try:
        data     = request.json
        name     = data.get('name')
        email    = data.get('email')
        password = data.get('password')
        phone    = data.get('phone', '')

        if not all([name, email, password]):
            return jsonify({'success': False, 'message': 'Missing required fields'}), 400

        account_number = f"ACC{datetime.now().strftime('%Y%m%d%H%M%S')}"

        conn = get_db()
        c = conn.cursor()

        c.execute("SELECT id FROM dashboard_users WHERE email=%s", (email,))
        if c.fetchone():
            release_db(conn)
            return jsonify({'success': False, 'message': 'Email already registered'}), 400

        password_hash = generate_password_hash(password)
        c.execute("""
            INSERT INTO dashboard_users
                (account_number, name, email, password_hash, phone, balance, points, created_at, status)
            VALUES (%s, %s, %s, %s, %s, 50000, 100, %s, 'active')
            RETURNING id
        """, (account_number, name, email, password_hash, phone, datetime.utcnow().isoformat()))

        user_id = c.fetchone()['id']
        conn.commit()
        release_db(conn)

        session['user_id']        = user_id
        session['account_number'] = account_number

        return jsonify({
            'success':        True,
            'message':        'Registration successful',
            'account_number': account_number
        })

    except Exception as e:
        return jsonify({'success': False, 'message': str(e)}), 500


@app.route('/api/auth/login', methods=['POST'])
def login():
    """Accepts EITHER {email, password} (legacy accounts) OR
    {phone, pin} (new phone/OTP/CNIC/PIN accounts, where phone IS the
    account_number). Both paths land in the same session shape, so
    every downstream route (Dashboard, Chat, features.py) is unaffected."""
    try:
        data  = request.json or {}
        email = data.get('email')
        phone = data.get('phone')

        if phone:
            phone_digits = ''.join(ch for ch in phone if ch.isdigit())
            pin = data.get('pin')
            if not pin:
                return jsonify({'success': False, 'message': 'Missing phone or PIN'}), 400

            conn = get_db()
            c    = conn.cursor()
            c.execute(
                "SELECT id, account_number, pin_hash, status FROM dashboard_users WHERE account_number=%s",
                (phone_digits,)
            )
            user = c.fetchone()
            release_db(conn)

            if not user or not user['pin_hash'] or not check_password_hash(user['pin_hash'], pin):
                return jsonify({'success': False, 'message': 'Invalid phone number or PIN'}), 401
            if user['status'] != 'active':
                return jsonify({'success': False, 'message': 'Account setup is incomplete. Please finish registration.'}), 403

            session['user_id']        = user['id']
            session['account_number'] = user['account_number']
            return jsonify({'success': True, 'message': 'Login successful', 'account_number': user['account_number']})

        # ── Legacy email/password path ──────────────────────────────────
        password = data.get('password')
        if not all([email, password]):
            return jsonify({'success': False, 'message': 'Missing email or password'}), 400

        conn = get_db()
        c    = conn.cursor()
        c.execute(
            "SELECT id, account_number, password_hash FROM dashboard_users WHERE email=%s",
            (email,)
        )
        user = c.fetchone()
        release_db(conn)

        if not user or not user['password_hash'] or not check_password_hash(user['password_hash'], password):
            return jsonify({'success': False, 'message': 'Invalid email or password'}), 401

        session['user_id']        = user['id']
        session['account_number'] = user['account_number']

        return jsonify({
            'success':        True,
            'message':        'Login successful',
            'account_number': user['account_number']
        })

    except Exception as e:
        return jsonify({'success': False, 'message': str(e)}), 500


# ── Phone / OTP / CNIC / PIN signup flow ────────────────────────────────────
# NOTE: There is no real telecom SMS gateway or NADRA/VeriSys access available
# for this student project. Both external calls are mocked below, clearly
# marked, and shaped so a real integration could later be dropped in without
# changing the surrounding logic.

OTP_TTL_MINUTES      = 5
OTP_MAX_ATTEMPTS      = 5
OTP_MAX_REQUESTS      = 5      # per phone number
OTP_REQUEST_WINDOW_MIN = 60    # per this many minutes
WEAK_PINS = {'00000', '11111', '22222', '33333', '44444', '55555',
             '66666', '77777', '88888', '99999', '12345', '54321'}


def _mock_send_otp(phone_digits, otp_code):
    """MOCKED: a real implementation would call a telecom SMS gateway here
    (e.g. Twilio, a local aggregator). For this student project we just
    log it server-side and return it in the API response so the frontend
    can display it in a clearly-labelled 'demo mode' banner."""
    print(f"[MOCK SMS] OTP for {phone_digits}: {otp_code}")
    return True


def _mock_verify_cnic(cnic_digits):
    """MOCKED: a real implementation would call NADRA VeriSys here to
    confirm the CNIC is valid and matches the phone owner. We simulate a
    network round-trip and accept any well-formed 13-digit CNIC."""
    import time as _time
    _time.sleep(0.8)  # simulate API latency so the UI feels real
    if len(cnic_digits) != 13:
        return {'verified': False}
    return {'verified': True}


@app.route('/api/auth/register/phone', methods=['POST'])
def register_phone():
    try:
        data  = request.json or {}
        phone = data.get('phone', '')
        phone_digits = ''.join(ch for ch in phone if ch.isdigit())

        if len(phone_digits) != 11:
            return jsonify({'success': False, 'message': 'Enter a valid 11-digit phone number.'}), 400

        conn = get_db()
        c    = conn.cursor()
        c.execute("SELECT id, status, otp_requests_count, otp_requests_window_started_at "
                   "FROM dashboard_users WHERE account_number=%s", (phone_digits,))
        existing = c.fetchone()

        if existing and existing['status'] == 'active':
            release_db(conn)
            return jsonify({'success': False, 'message': 'An account with this phone number already exists. Please log in.'}), 400

        # ── Rate limit OTP requests per phone number ────────────────────
        now = datetime.utcnow()
        if existing:
            window_start = existing['otp_requests_window_started_at']
            count = existing['otp_requests_count'] or 0
            if window_start and (now - window_start).total_seconds() < OTP_REQUEST_WINDOW_MIN * 60:
                if count >= OTP_MAX_REQUESTS:
                    release_db(conn)
                    return jsonify({'success': False, 'message': 'Too many OTP requests. Please try again later.'}), 429
                new_count, new_window = count + 1, window_start
            else:
                new_count, new_window = 1, now
        else:
            new_count, new_window = 1, now

        otp_code = f"{secrets.randbelow(1_000_000):06d}"
        otp_hash = generate_password_hash(otp_code)
        expires_at = now + timedelta(minutes=OTP_TTL_MINUTES)

        if existing:
            c.execute("""
                UPDATE dashboard_users
                SET otp_hash=%s, otp_expires_at=%s, otp_attempts=0, status='pending_otp',
                    otp_last_sent_at=%s, otp_requests_count=%s, otp_requests_window_started_at=%s
                WHERE account_number=%s
            """, (otp_hash, expires_at, now, new_count, new_window, phone_digits))
        else:
            c.execute("""
                INSERT INTO dashboard_users
                    (account_number, name, phone, balance, points, created_at, status,
                     otp_hash, otp_expires_at, otp_attempts, otp_last_sent_at,
                     otp_requests_count, otp_requests_window_started_at)
                VALUES (%s, '', %s, 0, 0, %s, 'pending_otp', %s, %s, 0, %s, %s, %s)
            """, (phone_digits, phone_digits, now.isoformat(), otp_hash, expires_at,
                  now, new_count, new_window))

        conn.commit()
        release_db(conn)

        _mock_send_otp(phone_digits, otp_code)

        return jsonify({
            'success': True,
            'message': 'OTP sent.',
            # DEMO ONLY: no real SMS gateway is available for this project,
            # so the OTP is returned here for the frontend to display.
            'dev_otp': otp_code
        })
    except Exception as e:
        return jsonify({'success': False, 'message': str(e)}), 500


@app.route('/api/auth/register/verify-otp', methods=['POST'])
def register_verify_otp():
    try:
        data  = request.json or {}
        phone_digits = ''.join(ch for ch in data.get('phone', '') if ch.isdigit())
        otp   = data.get('otp', '')

        if not phone_digits or not otp:
            return jsonify({'success': False, 'message': 'Missing phone or OTP'}), 400

        conn = get_db()
        c    = conn.cursor()
        c.execute("SELECT otp_hash, otp_expires_at, otp_attempts, status "
                   "FROM dashboard_users WHERE account_number=%s", (phone_digits,))
        user = c.fetchone()

        if not user or user['status'] != 'pending_otp' or not user['otp_hash']:
            release_db(conn)
            return jsonify({'success': False, 'message': 'No pending OTP for this number. Please request a new one.'}), 400

        if user['otp_attempts'] >= OTP_MAX_ATTEMPTS:
            release_db(conn)
            return jsonify({'success': False, 'message': 'Too many incorrect attempts. Please request a new OTP.'}), 429

        if datetime.utcnow() > user['otp_expires_at']:
            release_db(conn)
            return jsonify({'success': False, 'message': 'OTP expired. Please request a new one.'}), 400

        if not check_password_hash(user['otp_hash'], otp):
            c.execute("UPDATE dashboard_users SET otp_attempts = otp_attempts + 1 WHERE account_number=%s",
                       (phone_digits,))
            conn.commit()
            release_db(conn)
            return jsonify({'success': False, 'message': 'Incorrect OTP.'}), 401

        # Correct — consume the OTP so it can't be reused, advance status
        c.execute("""
            UPDATE dashboard_users
            SET status='phone_verified', otp_hash=NULL, otp_expires_at=NULL, otp_attempts=0
            WHERE account_number=%s
        """, (phone_digits,))
        conn.commit()
        release_db(conn)

        return jsonify({'success': True, 'message': 'Phone number verified.'})
    except Exception as e:
        return jsonify({'success': False, 'message': str(e)}), 500


@app.route('/api/auth/register/cnic', methods=['POST'])
def register_cnic():
    try:
        data  = request.json or {}
        phone_digits = ''.join(ch for ch in data.get('phone', '') if ch.isdigit())
        cnic_digits  = ''.join(ch for ch in data.get('cnic', '') if ch.isdigit())

        if len(cnic_digits) != 13:
            return jsonify({'success': False, 'message': 'Enter a valid 13-digit CNIC number.'}), 400

        conn = get_db()
        c    = conn.cursor()
        c.execute("SELECT status FROM dashboard_users WHERE account_number=%s", (phone_digits,))
        user = c.fetchone()

        if not user or user['status'] != 'phone_verified':
            release_db(conn)
            return jsonify({'success': False, 'message': 'Please verify your phone number first.'}), 400

        c.execute("SELECT id FROM dashboard_users WHERE cnic=%s AND account_number != %s", (cnic_digits, phone_digits))
        if c.fetchone():
            release_db(conn)
            return jsonify({'success': False, 'message': 'This CNIC is already registered to another account.'}), 400

        result = _mock_verify_cnic(cnic_digits)
        if not result['verified']:
            release_db(conn)
            return jsonify({'success': False, 'message': 'CNIC could not be verified.'}), 400

        c.execute("UPDATE dashboard_users SET cnic=%s, status='cnic_verified' WHERE account_number=%s",
                   (cnic_digits, phone_digits))
        conn.commit()
        release_db(conn)

        return jsonify({'success': True, 'message': 'CNIC verified.'})
    except Exception as e:
        return jsonify({'success': False, 'message': str(e)}), 500


@app.route('/api/auth/register/complete', methods=['POST'])
def register_complete():
    try:
        data  = request.json or {}
        phone_digits = ''.join(ch for ch in data.get('phone', '') if ch.isdigit())
        display_name = (data.get('displayName') or '').strip()
        pin = data.get('pin', '')

        if not display_name:
            return jsonify({'success': False, 'message': 'Please enter a display name.'}), 400
        if not (pin.isdigit() and len(pin) == 5):
            return jsonify({'success': False, 'message': 'PIN must be exactly 5 digits.'}), 400
        if pin in WEAK_PINS:
            return jsonify({'success': False, 'message': 'That PIN is too easy to guess. Please choose another.'}), 400

        conn = get_db()
        c    = conn.cursor()
        c.execute("SELECT id, status FROM dashboard_users WHERE account_number=%s", (phone_digits,))
        user = c.fetchone()

        if not user or user['status'] != 'cnic_verified':
            release_db(conn)
            return jsonify({'success': False, 'message': 'Please complete phone and CNIC verification first.'}), 400

        pin_hash = generate_password_hash(pin)
        c.execute("""
            UPDATE dashboard_users
            SET name=%s, pin_hash=%s, status='active', balance=50000, points=100
            WHERE account_number=%s
        """, (display_name, pin_hash, phone_digits))
        conn.commit()
        release_db(conn)

        session['user_id']        = user['id']
        session['account_number'] = phone_digits

        return jsonify({'success': True, 'message': 'Account created.', 'account_number': phone_digits})
    except Exception as e:
        return jsonify({'success': False, 'message': str(e)}), 500


@app.route('/api/auth/forgot-pin/request', methods=['POST'])
def forgot_pin_request():
    """Sends a mock OTP to reset the PIN for an existing active account.
    Reuses the same otp_* columns/rate-limit as signup, but never touches
    `status` — the account stays active throughout."""
    try:
        data  = request.json or {}
        phone_digits = ''.join(ch for ch in data.get('phone', '') if ch.isdigit())
        if len(phone_digits) != 11:
            return jsonify({'success': False, 'message': 'Enter a valid 11-digit phone number.'}), 400

        conn = get_db()
        c    = conn.cursor()
        c.execute("SELECT status, otp_requests_count, otp_requests_window_started_at "
                   "FROM dashboard_users WHERE account_number=%s", (phone_digits,))
        user = c.fetchone()

        if not user or user['status'] != 'active' or not user['status']:
            release_db(conn)
            return jsonify({'success': False, 'message': 'No account found for this phone number.'}), 404

        now = datetime.utcnow()
        window_start = user['otp_requests_window_started_at']
        count = user['otp_requests_count'] or 0
        if window_start and (now - window_start).total_seconds() < OTP_REQUEST_WINDOW_MIN * 60:
            if count >= OTP_MAX_REQUESTS:
                release_db(conn)
                return jsonify({'success': False, 'message': 'Too many OTP requests. Please try again later.'}), 429
            new_count, new_window = count + 1, window_start
        else:
            new_count, new_window = 1, now

        otp_code = f"{secrets.randbelow(1_000_000):06d}"
        otp_hash = generate_password_hash(otp_code)
        expires_at = now + timedelta(minutes=OTP_TTL_MINUTES)

        c.execute("""
            UPDATE dashboard_users
            SET otp_hash=%s, otp_expires_at=%s, otp_attempts=0,
                otp_last_sent_at=%s, otp_requests_count=%s, otp_requests_window_started_at=%s
            WHERE account_number=%s
        """, (otp_hash, expires_at, now, new_count, new_window, phone_digits))
        conn.commit()
        release_db(conn)

        _mock_send_otp(phone_digits, otp_code)
        return jsonify({'success': True, 'message': 'OTP sent.', 'dev_otp': otp_code})
    except Exception as e:
        return jsonify({'success': False, 'message': str(e)}), 500


@app.route('/api/auth/forgot-pin/reset', methods=['POST'])
def forgot_pin_reset():
    try:
        data  = request.json or {}
        phone_digits = ''.join(ch for ch in data.get('phone', '') if ch.isdigit())
        otp = data.get('otp', '')
        new_pin = data.get('newPin', '')

        if not (new_pin.isdigit() and len(new_pin) == 5):
            return jsonify({'success': False, 'message': 'PIN must be exactly 5 digits.'}), 400
        if new_pin in WEAK_PINS:
            return jsonify({'success': False, 'message': 'That PIN is too easy to guess. Please choose another.'}), 400

        conn = get_db()
        c    = conn.cursor()
        c.execute("SELECT status, otp_hash, otp_expires_at, otp_attempts "
                   "FROM dashboard_users WHERE account_number=%s", (phone_digits,))
        user = c.fetchone()

        if not user or user['status'] != 'active' or not user['otp_hash']:
            release_db(conn)
            return jsonify({'success': False, 'message': 'No pending reset for this number. Please request a new OTP.'}), 400
        if user['otp_attempts'] >= OTP_MAX_ATTEMPTS:
            release_db(conn)
            return jsonify({'success': False, 'message': 'Too many incorrect attempts. Please request a new OTP.'}), 429
        if datetime.utcnow() > user['otp_expires_at']:
            release_db(conn)
            return jsonify({'success': False, 'message': 'OTP expired. Please request a new one.'}), 400
        if not check_password_hash(user['otp_hash'], otp):
            c.execute("UPDATE dashboard_users SET otp_attempts = otp_attempts + 1 WHERE account_number=%s", (phone_digits,))
            conn.commit()
            release_db(conn)
            return jsonify({'success': False, 'message': 'Incorrect OTP.'}), 401

        new_hash = generate_password_hash(new_pin)
        c.execute("""
            UPDATE dashboard_users
            SET pin_hash=%s, otp_hash=NULL, otp_expires_at=NULL, otp_attempts=0
            WHERE account_number=%s
        """, (new_hash, phone_digits))
        conn.commit()
        release_db(conn)

        return jsonify({'success': True, 'message': 'PIN reset successful.'})
    except Exception as e:
        return jsonify({'success': False, 'message': str(e)}), 500


@app.route('/api/auth/logout', methods=['POST'])
def logout():
    session.clear()
    return jsonify({'success': True, 'message': 'Logged out successfully'})


# ═══════════════════════════════════════════════════════════════════════════
# CHATBOT API  — includes LLM general_chat + llm_used flag
# ═══════════════════════════════════════════════════════════════════════════

@app.route('/api/chat/message', methods=['POST'])
def chat_message():
    if 'user_id' not in session:
        return jsonify({'success': False, 'message': 'Not authenticated'}), 401

    try:
        data         = request.json
        user_message = data.get('message', '').strip()

        if not user_message:
            return jsonify({'success': False, 'message': 'Empty message'}), 400

        account_number = session['account_number']

        # ── Financial Advisor chat bubble ──────────────────────────────────────
        # Sent as {message, context: 'financial_advisor'} from the Grow My Money
        # chat bubble. Handled here, separately from the BankAIConversation state
        # machine below, since it's a one-shot Q&A over the user's real numbers
        # rather than a multi-step banking flow. See advisor_chat.py.
        if data.get('context') == 'financial_advisor':
            from advisor_chat import handle_advisor_chat
            try:
                financial_summary = get_income_vs_expense(account_number)
            except Exception:
                financial_summary = {}

            user_context = {
                'income': financial_summary.get('income'),
                'expenses': financial_summary.get('expenses'),
                'net': financial_summary.get('net'),
                'experience_level': session.get('advisor_experience_level'),
                'risk_preference': session.get('advisor_risk_preference'),
            }
            ai_response = handle_advisor_chat(user_message, user_context)
            return jsonify({
                'success': True,
                'ai_response': ai_response,
                'intent': 'financial_advisor',
                'language': 'en',
                'llm_used': True
            })

        conn = get_db()
        c = conn.cursor()
        c.execute(
            "SELECT name, balance, points, password_hash FROM dashboard_users WHERE account_number=%s",
            (account_number,)
        )
        user = c.fetchone()

        if not user:
            release_db(conn)
            return jsonify({'success': False, 'message': 'User not found'}), 404

        # PostgreSQL returns NUMERIC columns as decimal.Decimal, which can't be
        # mixed with the plain floats used below (amount, redemption_choice,
        # etc.) — cast once here so every arithmetic op further down works.
        user['balance'] = float(user['balance'])
        user['points']  = int(user['points'])

        # ── Human-mode bypass ───────────────────────────────────────────────
        # If a banker has taken this conversation over (via Live Chat Monitor
        # or by claiming the ticket), the bot needs to stay quiet instead of
        # auto-replying on top of the banker. Just log the message and let
        # the banker see it — no NLP, no ai_response.
        c.execute("SELECT mode FROM conversation_state WHERE account_number = %s", (account_number,))
        conv_state_row = c.fetchone()
        if conv_state_row and conv_state_row['mode'] == 'human':
            c.execute("""
                INSERT INTO chat_history(account_number, user_message, ai_response, intent, created_at, sender)
                VALUES (%s, %s, NULL, 'human_mode_message', %s, 'user')
            """, (account_number, user_message, datetime.utcnow().isoformat()))
            conn.commit()
            release_db(conn)
            return jsonify({
                'success':     True,
                'ai_response': None,
                'intent':      'human_mode_message',
                'language':    'en',
                'llm_used':    False,
                'human_mode':  True
            })

        conversation_context = session.get('conversation_context', {})

        # ── Explicit cancel mid-flow ─────────────────────────────────────────
        # There's no dedicated "cancel" intent in the NLP layer, so this is
        # handled here directly: if the customer is partway through a
        # multi-step flow (awaiting a password, or mid-way through providing
        # transfer/bill/redeem details) and says "cancel" (or an equivalent),
        # stop the flow right here instead of handing it to the NLP layer.
        CANCEL_PHRASES = {'cancel', 'cancel it', 'cancel that', 'cancel transaction',
                           'cancel this', 'nevermind', 'never mind', 'stop', 'abort'}
        is_mid_flow = bool(
            conversation_context.get('awaiting_password')
            or conversation_context.get('awaiting_emergency_password')
            or conversation_context.get('current_flow')
        )
        if is_mid_flow and user_message.strip().lower() in CANCEL_PHRASES:
            session['conversation_context'] = {}
            ai_response = "No problem, I've cancelled that. Is there anything else I can help with?"

            c.execute("""
                INSERT INTO chat_history(account_number, user_message, ai_response, intent, created_at)
                VALUES (%s, %s, %s, %s, %s)
            """, (account_number, user_message, ai_response, 'cancelled', datetime.utcnow().isoformat()))
            conn.commit()
            release_db(conn)

            return jsonify({
                'success':       True,
                'ai_response':   ai_response,
                'intent':        'cancelled',
                'language':      'en',
                'llm_used':      False,
                'session_reset': True
            })
        nlp_result = chatbot.process_message(user_message, conversation_context)

        intent    = nlp_result['intent']
        language  = nlp_result['language']
        entities  = nlp_result.get('entities', {})
        llm_used  = nlp_result.get('llm_used', False)

        # ── Log LLM usage so you can track fallback rate ──────────────────────
        if llm_used:
            logger.info(
                "LLM fallback used | account=%s | intent=%s | flow=%s",
                account_number, intent, conversation_context.get('current_flow')
            )

        # ── Emergency password ─────────────────────────────────────────────────
        if intent == 'emergency_password_provided':
            password = entities.get('password', '')
            attempts = nlp_result.get('emergency_attempts', 3)

            if check_password_hash(user['password_hash'], password):
                c.execute(
                    "UPDATE cards SET status='locked' WHERE account_number=%s",
                    (account_number,)
                )
                c.execute(
                    "INSERT INTO fraud_alerts(account_number, message, created_at) VALUES (%s, %s, %s)",
                    (account_number, "Emergency mode triggered by user.", datetime.utcnow().isoformat())
                )
                conn.commit()
                ai_response = chatbot.responses['emergency_confirm'][language]
                session['conversation_context'] = {}
                session_reset = True
            else:
                attempts -= 1
                if attempts > 0:
                    ai_response = chatbot.responses['emergency_password_incorrect'][language].format(attempts=attempts)
                    session['conversation_context'] = {
                        'awaiting_emergency_password': True,
                        'emergency_attempts': attempts
                    }
                    session_reset = False
                else:
                    ai_response = chatbot.responses['emergency_failed'][language]
                    session['conversation_context'] = {}
                    session_reset = True

            c.execute("""
                INSERT INTO chat_history(account_number, user_message, ai_response, intent, created_at)
                VALUES (%s, %s, %s, %s, %s)
            """, (account_number, "[Password verification]", ai_response, 'emergency',
                  datetime.utcnow().isoformat()))
            conn.commit()
            release_db(conn)

            return jsonify({
                'success':      True,
                'ai_response':  ai_response,
                'intent':       'emergency',
                'language':     language,
                'llm_used':     llm_used,
                'session_reset': session_reset
            })

        # ── Transaction password ───────────────────────────────────────────────
        if intent == 'password_provided':
            password        = entities.get('password', '')
            original_intent = nlp_result.get('original_intent')

            if not check_password_hash(user['password_hash'], password):
                ai_response = chatbot.responses['password_incorrect'][language]
                session['conversation_context'] = {}

                c.execute("""
                    INSERT INTO chat_history(account_number, user_message, ai_response, intent, created_at)
                    VALUES (%s, %s, %s, %s, %s)
                """, (account_number, "[Password verification]", ai_response, original_intent,
                      datetime.utcnow().isoformat()))
                conn.commit()
                release_db(conn)

                return jsonify({
                    'success':    True,
                    'ai_response': ai_response,
                    'intent':     original_intent,
                    'language':   language,
                    'llm_used':   llm_used
                })

            session_reset = False

            if original_intent == 'transfer_money':
                amount              = entities.get('amount')
                recipient           = entities.get('recipient')
                transfer_method     = entities.get('transfer_method')
                recipient_account   = entities.get('transfer_identifier')
                purpose             = entities.get('purpose')
                description         = entities.get('description')

                if user['balance'] < amount:
                    ai_response = chatbot.responses['insufficient_funds'][language].format(balance=user['balance'])
                    session['conversation_context'] = {}
                else:
                    points_earned = int(amount // 1000) * 5
                    new_balance   = user['balance'] - amount
                    new_points    = user['points'] + points_earned

                    c.execute(
                        "UPDATE dashboard_users SET balance=%s, points=%s WHERE account_number=%s",
                        (new_balance, new_points, account_number)
                    )
                    c.execute("""
                        INSERT INTO dashboard_transactions
                            (account_number, transaction_type, description, amount, recipient, status, created_at, category)
                        VALUES (%s, 'transfer', %s, %s, %s, 'completed', %s, %s)
                    """, (account_number, f"Transfer to {recipient} ({transfer_method}, {purpose})", -amount,
                          recipient_account, datetime.utcnow().isoformat(), description))
                    conn.commit()

                    ai_response = chatbot.responses['transfer_success'][language].format(
                        amount=amount, recipient=recipient,
                        balance=new_balance, points=points_earned
                    )
                    session['conversation_context'] = {}
                    session_reset = True

            elif original_intent == 'pay_bill':
                bill_type        = entities.get('bill_category')
                amount            = entities.get('amount')
                service_provider  = entities.get('service_provider')
                bill_account      = entities.get('bill_reference')

                if user['balance'] < amount:
                    ai_response = chatbot.responses['insufficient_funds'][language].format(balance=user['balance'])
                    session['conversation_context'] = {
                        'current_flow':             'pay_bill',
                        'bill_category':            bill_type,
                        'service_provider':         service_provider,
                        'amount':                   amount,
                        'bill_reference':           bill_account,
                        'insufficient_funds_retry': True,
                        'session_language':         language
                    }
                else:
                    points_earned = int(amount // 1000) * 5
                    new_balance   = user['balance'] - amount
                    new_points    = user['points'] + points_earned

                    c.execute(
                        "UPDATE dashboard_users SET balance=%s, points=%s WHERE account_number=%s",
                        (new_balance, new_points, account_number)
                    )
                    c.execute("""
                        INSERT INTO dashboard_transactions
                            (account_number, transaction_type, description, amount,
                             biller, bill_id, status, created_at)
                        VALUES (%s, 'bill', %s, %s, %s, %s, 'completed', %s)
                    """, (account_number, f"{bill_type} Bill Payment", -amount,
                          service_provider, bill_account, datetime.utcnow().isoformat()))
                    conn.commit()

                    ai_response = chatbot.responses['bill_payment_success'][language].format(
                        bill_type=bill_type, amount=amount,
                        balance=new_balance, points=points_earned
                    )
                    session['conversation_context'] = {}
                    session_reset = True

            elif original_intent == 'redeem_points':
                redemption_choice = entities.get('redemption_choice')
                points_needed     = 1000 if redemption_choice == 500 else 500

                if user['points'] < points_needed:
                    ai_response = chatbot.responses['insufficient_points'][language].format(
                        points=user['points'], required=points_needed
                    )
                    session['conversation_context'] = {}
                else:
                    new_points  = user['points']  - points_needed
                    new_balance = user['balance'] + redemption_choice

                    c.execute(
                        "UPDATE dashboard_users SET points=%s, balance=%s WHERE account_number=%s",
                        (new_points, new_balance, account_number)
                    )
                    c.execute("""
                        INSERT INTO redemptions(account_number, points_used, reward_value, created_at)
                        VALUES (%s, %s, %s, %s)
                    """, (account_number, points_needed, redemption_choice,
                          datetime.utcnow().isoformat()))
                    c.execute("""
                        INSERT INTO dashboard_transactions
                            (account_number, transaction_type, description, amount, status, created_at)
                        VALUES (%s, 'redemption', 'Points Redemption', %s, 'completed', %s)
                    """, (account_number, redemption_choice, datetime.utcnow().isoformat()))
                    conn.commit()

                    ai_response = chatbot.responses['redeem_success'][language].format(
                        points_used=points_needed, reward_value=redemption_choice,
                        balance=new_balance, remaining_points=new_points
                    )
                    session['conversation_context'] = {}
                    session_reset = True

            c.execute("""
                INSERT INTO chat_history(account_number, user_message, ai_response, intent, created_at)
                VALUES (%s, %s, %s, %s, %s)
            """, (account_number, "[Password verification]", ai_response, original_intent,
                  datetime.utcnow().isoformat()))
            conn.commit()
            release_db(conn)

            return jsonify({
                'success':      True,
                'ai_response':  ai_response,
                'intent':       original_intent,
                'language':     language,
                'llm_used':     llm_used,
                'session_reset': session_reset
            })

        # ── Context management ─────────────────────────────────────────────────
        if nlp_result.get('awaiting_emergency_password'):
            session['conversation_context'] = {
                'awaiting_emergency_password': True,
                'emergency_attempts': nlp_result.get('emergency_attempts', 3),
                'session_language': nlp_result.get('session_language')
            }
        elif nlp_result.get('awaiting_password'):
            session['conversation_context'] = {
                'awaiting_password': True,
                'original_intent':  nlp_result.get('original_intent'),
                'pending_entities': nlp_result.get('pending_entities', {}),
                'session_language': nlp_result.get('session_language')
            }
        elif nlp_result.get('current_flow'):
            context = {'current_flow': nlp_result['current_flow']}
            for key in ['amount', 'recipient', 'bill_type', 'bill_reference',
                        'redemption_choice', 'account_number', 'flow_state',
                        'transfer_method', 'transfer_identifier', 'purpose',
                        'description', 'bill_category', 'service_provider',
                        'provider_hint']:
                if key in nlp_result:
                    context[key] = nlp_result[key]
            context['session_language'] = nlp_result.get('session_language')
            session['conversation_context'] = context
        else:
            session['conversation_context'] = {}

        ai_response = nlp_result.get('ai_response')

        # ── Resolve intent responses ───────────────────────────────────────────
        if intent == 'check_balance':
            ai_response = chatbot.responses['check_balance'][language].format(balance=user['balance'])

        elif intent == 'check_rewards':
            ai_response = chatbot.responses['check_rewards'][language].format(points=user['points'])

        elif intent == 'transaction_history':
            c.execute("""
                SELECT transaction_type, description, amount, created_at
                FROM dashboard_transactions
                WHERE account_number=%s
                ORDER BY created_at DESC
                LIMIT 5
            """, (account_number,))
            transactions = c.fetchall()
            ai_response  = chatbot.responses['transaction_history'][language] + ":\n\n"
            if transactions:
                for txn in transactions:
                    date        = datetime.fromisoformat(txn['created_at']).strftime('%b %d')
                    ai_response += f"• {txn['description']}: RS {abs(txn['amount']):,.0f} ({date})\n"
            else:
                ai_response += "No recent transactions found."

        elif intent == 'bill_reminders':
            ai_response  = chatbot.responses['bill_reminders'][language]
            ai_response += "\n\n• K-Electric: PKR 3,500 (Due in 3 days)\n• PTCL: PKR 1,200 (Due today)"

        # ── LLM general_chat ─────────────────────────────────────────────────
        # The LLM answered a general banking question (e.g. "what is a SWIFT code?")
        # and put the reply in ai_response already — just pass it through.
        elif intent == 'general_chat':
            if not ai_response:
                # Shouldn't happen if LLM ran correctly, but safe fallback:
                ai_response = "I can help with balance checks, transfers, bill payments, and reward points. What would you like to do?"

        elif intent == 'unknown':
            ai_response = chatbot.responses['unknown'][language]

        if ai_response is None:
            ai_response = chatbot.responses['unknown'][language]

        c.execute("""
            INSERT INTO chat_history(account_number, user_message, ai_response, intent, created_at)
            VALUES (%s, %s, %s, %s, %s)
        """, (account_number, user_message, ai_response, intent, datetime.utcnow().isoformat()))

        conn.commit()
        release_db(conn)

        # Read back context so frontend knows whether to show password modal
        ctx                   = session.get('conversation_context', {})
        awaiting_pw           = ctx.get('awaiting_password', False)
        awaiting_emergency_pw = ctx.get('awaiting_emergency_password', False)

        # Merge pending_entities so the modal can display a proper summary
        effective_entities = dict(entities or {})
        if awaiting_pw or awaiting_emergency_pw:
            pending = ctx.get('pending_entities') or nlp_result.get('pending_entities') or {}
            effective_entities.update(pending)

        session.modified = True

        return jsonify({
            'success':                    True,
            'ai_response':                ai_response,
            'intent':                     ctx.get('original_intent') or nlp_result.get('original_intent') or intent,
            'language':                   language,
            'entities':                   effective_entities,
            'awaiting_password':          awaiting_pw,
            'awaiting_emergency_password': awaiting_emergency_pw,
            'llm_used':                   llm_used,   # ← LLM fallback tracking field
            'session_reset':              False
        })

    except Exception as e:
        print(f"Chat error: {str(e)}")
        return jsonify({'success': False, 'message': 'An error occurred processing your message'}), 500


@app.route('/api/chat/history', methods=['GET'])
def chat_history_get():
    # Lets Chat.jsx restore the visible conversation on page load / return
    # from Dashboard, instead of starting blank every time. Pass ?since=
    # (an ISO timestamp) to only pull messages from the current "session"
    # onward — the frontend advances that marker whenever the conversation
    # is reset (cancel or a completed transaction), so this naturally stops
    # returning old, already-closed conversations.
    if 'user_id' not in session:
        return jsonify({'success': False, 'message': 'Not authenticated'}), 401

    account_number = session['account_number']
    since = request.args.get('since', '').strip()

    conn = get_db()
    c    = conn.cursor()
    try:
        if since:
            c.execute("""
                SELECT id, user_message, ai_response, intent,
                       COALESCE(sender, 'ai') AS sender, engine, created_at
                FROM chat_history
                WHERE account_number = %s AND created_at >= %s
                ORDER BY created_at ASC
            """, (account_number, since))
        else:
            c.execute("""
                SELECT id, user_message, ai_response, intent,
                       COALESCE(sender, 'ai') AS sender, engine, created_at
                FROM chat_history
                WHERE account_number = %s
                ORDER BY created_at ASC
                LIMIT 200
            """, (account_number,))
        messages = [dict(r) for r in c.fetchall()]
    finally:
        release_db(conn)

    return jsonify({'success': True, 'messages': messages})


@app.route('/api/chat/transcribe', methods=['POST'])
def transcribe_audio():
    if 'user_id' not in session:
        return jsonify({'success': False, 'message': 'Not authenticated'}), 401

    try:
        if 'audio' not in request.files:
            return jsonify({'success': False, 'message': 'No audio file provided'}), 400

        audio_file = request.files['audio']

        if not SPEECH_RECOGNITION_AVAILABLE:
            return jsonify({
                'success': False,
                'message': 'Speech recognition not available.'
            }), 500

        audio_data = audio_file.read()
        recognizer = sr.Recognizer()

        try:
            audio_file_obj = io.BytesIO(audio_data)
            with sr.AudioFile(audio_file_obj) as source:
                audio = recognizer.record(source)

            text = recognizer.recognize_google(audio)
            return jsonify({
                'success': True,
                'text':    text,
                'message': 'Audio transcribed successfully'
            })

        except sr.UnknownValueError:
            return jsonify({'success': False, 'message': 'Could not understand audio.'}), 400
        except sr.RequestError:
            return jsonify({'success': False, 'message': 'Speech recognition service unavailable.'}), 500

    except Exception as e:
        print(f"Transcription error: {str(e)}")
        return jsonify({'success': False, 'message': 'Error transcribing audio'}), 500


@app.route('/api/chat/human-handoff', methods=['POST'])
def human_handoff():
    if 'user_id' not in session:
        return jsonify({'success': False, 'message': 'Not authenticated'}), 401

    try:
        account_number = session['account_number']
        language       = 'en'
        ai_response    = chatbot.responses['human_handoff'][language]

        conn = get_db()
        c    = conn.cursor()
        c.execute("""
            INSERT INTO chat_history(account_number, user_message, ai_response, intent, created_at)
            VALUES (%s, %s, %s, %s, %s)
        """, (account_number, "I want to talk to a human banker", ai_response,
              'human_agent', datetime.utcnow().isoformat()))

        # Also raise the actual support ticket and flip this conversation into
        # human mode, so it shows up in the admin console (Support Tickets /
        # Live Chat Monitor) instead of only being logged in chat_history.
        now = datetime.utcnow().isoformat()
        c.execute("""
            INSERT INTO handoff_queue(account_number, reason, status, created_at)
            VALUES (%s, 'user_requested_human', 'pending', %s)
        """, (account_number, now))
        c.execute("""
            INSERT INTO conversation_state(account_number, mode, assigned_to, updated_at)
            VALUES (%s, 'human', NULL, %s)
            ON CONFLICT(account_number) DO UPDATE SET
                mode='human', assigned_to=NULL, updated_at=EXCLUDED.updated_at
        """, (account_number, now))

        conn.commit()
        release_db(conn)

        return jsonify({'success': True, 'ai_response': ai_response})

    except Exception as e:
        return jsonify({'success': False, 'message': str(e)}), 500


@app.route('/api/chat/emergency', methods=['POST'])
def emergency():
    if 'user_id' not in session:
        return jsonify({'success': False, 'message': 'Not authenticated'}), 401

    try:
        account_number = session['account_number']
        nlp_result     = chatbot.process_message("emergency lock my cards", {})
        language       = nlp_result.get('language', 'en')
        ai_response    = nlp_result.get('ai_response', chatbot.responses['emergency_password_request'][language])

        session['conversation_context'] = {
            'awaiting_emergency_password': True,
            'emergency_attempts':          3
        }

        conn = get_db()
        c    = conn.cursor()
        c.execute("""
            INSERT INTO chat_history(account_number, user_message, ai_response, intent, created_at)
            VALUES (%s, %s, %s, %s, %s)
        """, (account_number, "EMERGENCY - Lock my cards!", ai_response,
              'emergency', datetime.utcnow().isoformat()))
        conn.commit()
        release_db(conn)

        return jsonify({'success': True, 'ai_response': ai_response})

    except Exception as e:
        return jsonify({'success': False, 'message': str(e)}), 500


@app.route('/api/chat/history', methods=['GET'])
def chat_history():
    if 'user_id' not in session:
        return jsonify({'success': False, 'message': 'Not authenticated'}), 401

    try:
        account_number = session['account_number']
        limit          = request.args.get('limit', 20, type=int)

        conn = get_db()
        c    = conn.cursor()
        c.execute("""
            SELECT user_message, ai_response, created_at
            FROM chat_history
            WHERE account_number=%s
            ORDER BY created_at DESC
            LIMIT %s
        """, (account_number, limit))

        messages = []
        for row in c.fetchall():
            messages.append({
                'user_message': row['user_message'],
                'ai_response':  row['ai_response'],
                'timestamp':    row['created_at']
            })

        release_db(conn)
        messages.reverse()
        return jsonify({'success': True, 'messages': messages})

    except Exception as e:
        return jsonify({'success': False, 'message': str(e)}), 500


# ═══════════════════════════════════════════════════════════════════════════
# USER API
# ═══════════════════════════════════════════════════════════════════════════

@app.route('/api/user/data', methods=['GET'])
def get_user_data():
    if 'user_id' not in session:
        return jsonify({'success': False, 'message': 'Not authenticated'}), 401

    try:
        account_number = session['account_number']
        conn = get_db()
        c    = conn.cursor()
        c.execute("""
            SELECT account_number, name, phone, balance, points
            FROM dashboard_users WHERE account_number=%s
        """, (account_number,))
        user = c.fetchone()
        release_db(conn)

        if not user:
            return jsonify({'success': False, 'message': 'User not found'}), 404

        name_parts = user['name'].strip().split(' ')
        initials   = (name_parts[0][0] + name_parts[1][0]).upper() if len(name_parts) >= 2 else user['name'][:2].upper()

        return jsonify({
            'name':    user['name'],
            'userId':  user['account_number'],
            'balance': float(user['balance']),
            'points':  user['points'],
            'initials': initials,
            'phone':   user['phone']
        })

    except Exception as e:
        return jsonify({'success': False, 'message': str(e)}), 500


@app.route('/api/user/verify-password', methods=['POST'])
def verify_password():
    if 'user_id' not in session:
        return jsonify({'success': False, 'message': 'Not authenticated'}), 401

    try:
        data     = request.json
        password = data.get('password')

        if not password:
            return jsonify({'success': False, 'message': 'Password required'}), 400

        user_id = session['user_id']
        conn    = get_db()
        c       = conn.cursor()
        c.execute("SELECT password_hash, pin_hash FROM dashboard_users WHERE id=%s", (user_id,))
        user = c.fetchone()
        release_db(conn)

        if not user:
            return jsonify({'success': False, 'message': 'User not found'}), 404

        # Phone/PIN accounts have pin_hash set and no password_hash; legacy
        # email accounts have password_hash and no pin_hash. Whichever one
        # this user has is what we check the submitted value against — the
        # frontend keeps sending it in the same `password` field either way.
        stored_hash = user['pin_hash'] or user['password_hash']
        if stored_hash and check_password_hash(stored_hash, password):
            return jsonify({'success': True})
        else:
            return jsonify({'success': False, 'message': 'Incorrect password'}), 401

    except Exception as e:
        return jsonify({'success': False, 'message': str(e)}), 500


@app.route('/api/user/change-password', methods=['POST'])
def change_password():
    if 'user_id' not in session:
        return jsonify({'success': False, 'message': 'Not authenticated'}), 401

    try:
        data             = request.json
        current_password = data.get('currentPassword')
        new_password     = data.get('newPassword')

        if not all([current_password, new_password]):
            return jsonify({'success': False, 'message': 'Missing required fields'}), 400

        user_id = session['user_id']
        conn    = get_db()
        c       = conn.cursor()
        c.execute("SELECT password_hash, pin_hash FROM dashboard_users WHERE id=%s", (user_id,))
        user = c.fetchone()

        if not user:
            release_db(conn)
            return jsonify({'success': False, 'message': 'User not found'}), 404

        is_pin_account = user['pin_hash'] is not None
        stored_hash = user['pin_hash'] or user['password_hash']

        if not stored_hash or not check_password_hash(stored_hash, current_password):
            release_db(conn)
            return jsonify({'success': False, 'message': 'Current password is incorrect'}), 401

        if is_pin_account:
            if not (new_password.isdigit() and len(new_password) == 5):
                release_db(conn)
                return jsonify({'success': False, 'message': 'New PIN must be exactly 5 digits'}), 400
            if new_password in WEAK_PINS:
                release_db(conn)
                return jsonify({'success': False, 'message': 'That PIN is too easy to guess. Please choose another.'}), 400
            new_hash = generate_password_hash(new_password)
            c.execute("UPDATE dashboard_users SET pin_hash=%s WHERE id=%s", (new_hash, user_id))
        else:
            if len(new_password) < 4:
                release_db(conn)
                return jsonify({'success': False, 'message': 'New password must be at least 4 characters'}), 400
            new_hash = generate_password_hash(new_password)
            c.execute("UPDATE dashboard_users SET password_hash=%s WHERE id=%s", (new_hash, user_id))

        conn.commit()
        release_db(conn)

        return jsonify({'success': True, 'message': 'Password updated successfully'})

    except Exception as e:
        return jsonify({'success': False, 'message': str(e)}), 500


@app.route('/api/user/topup', methods=['POST'])
def topup_balance():
    if 'user_id' not in session:
        return jsonify({'success': False, 'message': 'Not authenticated'}), 401

    data   = request.json
    amount = float(data.get('amount', 0))
    if amount <= 0:
        return jsonify({'success': False, 'message': 'Invalid amount'}), 400

    account_number = session['account_number']
    conn = get_db()
    c    = conn.cursor()
    c.execute(
        "UPDATE dashboard_users SET balance = balance + %s WHERE account_number=%s",
        (amount, account_number)
    )
    conn.commit()
    c.execute("SELECT balance FROM dashboard_users WHERE account_number=%s", (account_number,))
    new_balance = float(c.fetchone()['balance'])
    release_db(conn)

    return jsonify({'success': True, 'new_balance': new_balance})


# ═══════════════════════════════════════════════════════════════════════════
# TRANSACTION API
# ═══════════════════════════════════════════════════════════════════════════

# Valid expense categories (per mentor MoM Session 3)
EXPENSE_CATEGORIES = [
    'Utility Bills', 'Grocery', 'Household Staff',
    'Society Maintenance', 'Car & Fuel', 'Medical',
    'Education', 'Entertainment', 'Rent', 'Transfer', 'Other'
]


def _calc_transfer_fee(amount, is_finbud_user):
    """
    FinBud → FinBud  : free (0)
    FinBud → External: PKR 25 flat for amounts < 10,000
                       0.15% for amounts >= 10,000
    """
    if is_finbud_user:
        return 0.0
    return 25.0 if amount < 10000 else round(amount * 0.0015, 2)


# ═══════════════════════════════════════════════════════════════════════════
# SEND MONEY PIPELINE  (first_modal.pdf: Modal 1 method selection → Modal 2
# recipient details → Modal 3 amount → Modal 4 summary → Modal 5 PIN →
# Modal 6 success)
#
# These two endpoints power the multi-step Send Money modal only. They are
# additive — /api/transaction/create above is untouched and keeps serving
# whatever else already calls it.
# ═══════════════════════════════════════════════════════════════════════════

def _validate_iban(value):
    """
    Pakistani IBAN: 'PK' + 2 numeric check digits + 4-letter SBP bank code
    + 16 digits = 24 characters total (e.g. PK36SCBL0000001123456702).
    IBAN and a plain account number are NOT interchangeable — this only
    accepts the IBAN shape.
    """
    if not value or len(value) != 24:
        return False
    v = value.upper()
    return v[:2] == 'PK' and v[2:4].isdigit() and v[4:8].isalpha() and v[8:].isdigit()


def _validate_account_number(value):
    """
    Plain bank account number: digits only. Length varies by bank in real
    life, so we accept a broad 8-16 digit range rather than a fixed length
    (unlike IBAN, which is always exactly 24 characters).
    """
    return bool(value) and value.isdigit() and 8 <= len(value) <= 16


@app.route('/api/transfer/finbud/lookup', methods=['GET'])
def lookup_finbud_recipient():
    """
    Modal 2 support: verify a FinBud recipient by phone number so the UI can
    show "Transferring to {name}" before the user enters an amount.
    Query param: ?phone=03001234567
    Reply (found):     { success: true,  name, account_number }
    Reply (not found): { success: false, message } , HTTP 404
    """
    if 'user_id' not in session:
        return jsonify({'success': False, 'message': 'Not authenticated'}), 401

    phone = request.args.get('phone', '').strip()
    if not phone:
        return jsonify({'success': False, 'message': 'phone query param is required'}), 400

    try:
        conn = get_db(); c = conn.cursor()
        # Phone/PIN accounts use the phone number itself as account_number,
        # so match on either column to be safe.
        c.execute("""
            SELECT account_number, name FROM dashboard_users
            WHERE phone=%s OR account_number=%s
            LIMIT 1
        """, (phone, phone))
        recipient = c.fetchone()
        release_db(conn)

        if not recipient:
            return jsonify({
                'success': False,
                'message': 'No FinBud account exists for that phone number.'
            }), 404

        if recipient['account_number'] == session.get('account_number'):
            return jsonify({'success': False, 'message': "You can't send money to yourself."}), 400

        return jsonify({
            'success':        True,
            'name':           recipient['name'],
            'account_number': recipient['account_number']
        })

    except Exception as e:
        print(f"[lookup_finbud_recipient] error: {e}")
        return jsonify({'success': False, 'message': str(e)}), 500


@app.route('/api/transfer/execute', methods=['POST'])
def execute_transfer():
    """
    Single atomic endpoint behind Modal 3's "Confirm" → Modal 4 PIN entry.
    Handles both legs described in first_modal.pdf:

      • FinBud → FinBud : re-verifies the recipient server-side (never trusts
        the name the client already displayed), credits their balance, and
        logs a transaction + notification for BOTH sides. Fee: PKR 0.
      • FinBud → Bank    : mocked 1LINK transfer — validates the IBAN/account
        number is exactly 24 characters, applies the flat/percentage fee,
        and logs a transaction + transfer_fees row for the sender only.

    Body: {
      method: 'finbud' | 'bank',
      recipient_phone,        # required when method == 'finbud'
      bank_name,               # required when method == 'bank'
      identifier_type,         # 'iban' | 'account_number' — required when method == 'bank'
      account_id,               # the IBAN or account number itself
      amount, pin              # pin is the 5-digit PIN from Modal 5
    }
    Reply: { success, transaction_id, new_balance, fee, recipient_name, ... }
    """
    if 'user_id' not in session:
        return jsonify({'success': False, 'message': 'Not authenticated'}), 401

    data   = request.json or {}
    method = data.get('method')

    if method not in ('finbud', 'bank'):
        return jsonify({'success': False, 'message': "method must be 'finbud' or 'bank'"}), 400

    try:
        amount = float(data.get('amount', 0))
    except (TypeError, ValueError):
        return jsonify({'success': False, 'message': 'Invalid amount'}), 400
    if amount <= 0:
        return jsonify({'success': False, 'message': 'Please enter a valid positive amount.'}), 400

    # ── PIN format + strength check (Modal 4) ────────────────────────────────
    pin = str(data.get('pin', '')).strip()
    if len(pin) != 5 or not pin.isdigit():
        return jsonify({'success': False, 'message': 'PIN must be exactly 5 digits.'}), 400
    if pin in WEAK_PINS:
        return jsonify({'success': False, 'message': 'That PIN is too weak. Please set a different one.'}), 400

    account_number = session['account_number']
    conn = get_db(); c = conn.cursor()

    try:
        c.execute(
            "SELECT name, pin_hash, password_hash, balance, points "
            "FROM dashboard_users WHERE account_number=%s",
            (account_number,)
        )
        sender = c.fetchone()
        if not sender:
            release_db(conn)
            return jsonify({'success': False, 'message': 'User not found'}), 404

        # PIN verification against pin_hash (falls back to password_hash for
        # legacy email/password accounts that never set a PIN).
        stored_hash = sender['pin_hash'] or sender['password_hash']
        if not stored_hash or not check_password_hash(stored_hash, pin):
            release_db(conn)
            return jsonify({'success': False, 'message': 'Incorrect PIN. Please try again.'}), 401

        sender_balance = float(sender['balance'])
        sender_points  = int(sender['points'])

        recipient_account = None
        recipient_name    = None
        account_id         = None
        fee = 0.0

        if method == 'finbud':
            phone = str(data.get('recipient_phone', '')).strip()
            if not phone:
                release_db(conn)
                return jsonify({'success': False, 'message': 'Recipient phone number is required.'}), 400

            c.execute("""
                SELECT account_number, name FROM dashboard_users
                WHERE phone=%s OR account_number=%s LIMIT 1
            """, (phone, phone))
            recipient = c.fetchone()
            if not recipient:
                release_db(conn)
                return jsonify({'success': False, 'message': 'No FinBud account exists for that phone number.'}), 404
            if recipient['account_number'] == account_number:
                release_db(conn)
                return jsonify({'success': False, 'message': "You can't send money to yourself."}), 400

            recipient_account = recipient['account_number']
            recipient_name    = recipient['name']
            fee = 0.0  # FinBud → FinBud is always free

        else:  # bank
            bank_name       = str(data.get('bank_name', '')).strip()
            identifier_type = str(data.get('identifier_type', 'iban')).strip().lower()
            raw_id          = str(data.get('account_id', '')).strip()

            if not bank_name:
                release_db(conn)
                return jsonify({'success': False, 'message': 'Bank name is required.'}), 400

            if identifier_type == 'iban':
                account_id = raw_id.upper().replace(' ', '')
                if not _validate_iban(account_id):
                    release_db(conn)
                    return jsonify({
                        'success': False,
                        'message': 'Invalid IBAN. It must start with PK and be exactly 24 characters (e.g. PK36SCBL0000001123456702).'
                    }), 400
            elif identifier_type == 'account_number':
                account_id = raw_id.replace(' ', '')
                if not _validate_account_number(account_id):
                    release_db(conn)
                    return jsonify({
                        'success': False,
                        'message': 'Invalid account number. It must be 8–16 digits, numbers only.'
                    }), 400
            else:
                release_db(conn)
                return jsonify({'success': False, 'message': "identifier_type must be 'iban' or 'account_number'."}), 400

            fee = _calc_transfer_fee(amount, is_finbud_user=False)
            recipient_name = bank_name  # no FinBud DB record to verify against

        total_deducted = round(amount + fee, 2)
        if sender_balance < total_deducted:
            release_db(conn)
            return jsonify({
                'success': False,
                'message': f'Insufficient funds. Amount: PKR {amount:,.0f} + Fee: PKR {fee:,.0f} = PKR {total_deducted:,.0f}'
            }), 400

        now_iso       = datetime.utcnow().isoformat()
        points_earned = int(amount // 1000) * 5

        # Mock a brief 1LINK network round-trip for bank transfers so the
        # frontend's spinner (Modal 4 → Modal 5) has something real to show.
        if method == 'bank':
            time.sleep(0.6)

        description = (
            f"Transfer to {recipient_name}" if method == 'finbud'
            else f"Bank transfer to {recipient_name} ({'IBAN' if identifier_type == 'iban' else 'A/C'}: {account_id})"
        )
        if fee > 0:
            description += f" (Fee: PKR {fee:,.0f})"

        # ── Sender-side ledger entry (both methods) ──────────────────────────
        c.execute("""
            INSERT INTO dashboard_transactions
                (account_number, transaction_type, description, amount,
                 recipient, status, created_at, category, fee)
            VALUES (%s, 'transfer', %s, %s, %s, 'completed', %s, 'Transfer', %s)
            RETURNING id
        """, (account_number, description, -total_deducted,
              recipient_account or recipient_name, now_iso, fee))
        transaction_id = c.fetchone()['id']

        fee_percentage = (fee / amount) if amount else 0.0
        c.execute("""
            INSERT INTO transfer_fees
                (transaction_id, account_number, transfer_amount, fee_amount, fee_percentage, created_at)
            VALUES (%s, %s, %s, %s, %s, %s)
        """, (transaction_id, account_number, amount, fee, fee_percentage, now_iso))

        new_sender_balance = sender_balance - total_deducted
        new_sender_points  = sender_points + points_earned
        c.execute(
            "UPDATE dashboard_users SET balance=%s, points=%s WHERE account_number=%s",
            (new_sender_balance, new_sender_points, account_number)
        )

        c.execute("""
            INSERT INTO notifications(account_number, message, notif_type, is_read, created_at)
            VALUES (%s, %s, 'transaction', FALSE, %s)
        """, (
            account_number,
            f"PKR {amount:,.0f} sent to {recipient_name}. Remaining balance: PKR {new_sender_balance:,.0f}.",
            now_iso
        ))

        # ── Recipient-side ledger entry (FinBud → FinBud only) ───────────────
        if method == 'finbud':
            c.execute("""
                INSERT INTO dashboard_transactions
                    (account_number, transaction_type, description, amount,
                     recipient, status, created_at, category, fee)
                VALUES (%s, 'transfer', %s, %s, %s, 'completed', %s, 'Transfer', 0)
            """, (
                recipient_account,
                f"Received from {sender['name']}",
                amount, account_number, now_iso
            ))

            c.execute(
                "UPDATE dashboard_users SET balance = balance + %s WHERE account_number=%s",
                (amount, recipient_account)
            )

            c.execute("""
                INSERT INTO notifications(account_number, message, notif_type, is_read, created_at)
                VALUES (%s, %s, 'transaction', FALSE, %s)
            """, (
                recipient_account,
                f"PKR {amount:,.0f} received from {sender['name']}.",
                now_iso
            ))

        conn.commit()
        release_db(conn)

        return jsonify({
            'success':        True,
            'transaction_id': transaction_id,
            'new_balance':    float(new_sender_balance),
            'new_points':     new_sender_points,
            'points_earned':  points_earned,
            'fee':            fee,
            'fee_applied':    fee > 0,
            'recipient_name': recipient_name,
            'method':         method,
            'identifier_type': identifier_type if method == 'bank' else None
        })

    except Exception as e:
        conn.rollback()
        release_db(conn)
        print(f"[execute_transfer] error: {e}")
        return jsonify({'success': False, 'message': str(e)}), 500


@app.route('/api/transaction/create', methods=['POST'])
def create_transaction():
    if 'user_id' not in session:
        return jsonify({'success': False, 'message': 'Not authenticated'}), 401

    try:
        data             = request.json
        account_number   = session['account_number']
        transaction_type = data.get('type')
        amount           = float(data.get('amount'))
        category         = data.get('category', 'Other')

        # Validate category
        if category not in EXPENSE_CATEGORIES:
            category = 'Other'

        if not all([transaction_type, amount]):
            return jsonify({'success': False, 'message': 'Missing required fields'}), 400

        if amount <= 0:
            return jsonify({'success': False, 'message': 'Invalid amount'}), 400

        conn = get_db()
        c    = conn.cursor()
        c.execute(
            "SELECT balance, points FROM dashboard_users WHERE account_number=%s",
            (account_number,)
        )
        user = c.fetchone()

        if not user:
            release_db(conn)
            return jsonify({'success': False, 'message': 'User not found'}), 404

        # PostgreSQL returns NUMERIC columns as decimal.Decimal — cast to plain
        # float/int so subtraction/addition against `amount`/`fee` (floats)
        # below doesn't throw "unsupported operand type(s) for -".
        user['balance'] = float(user['balance'])
        user['points']  = int(user['points'])

        fee = 0.0
        if transaction_type == 'transfer':
            # Check if recipient is a FinBud user
            recipient_account = data.get('recipient_account', '')
            c.execute(
                "SELECT COUNT(*) AS cnt FROM dashboard_users WHERE account_number=%s",
                (recipient_account,)
            )
            is_finbud_user = c.fetchone()['cnt'] > 0
            fee = _calc_transfer_fee(amount, is_finbud_user)

        total_deducted = amount + fee

        if user['balance'] < total_deducted:
            release_db(conn)
            return jsonify({
                'success': False,
                'message': f'Insufficient funds. Amount: PKR {amount:,.0f} + Fee: PKR {fee:,.0f} = PKR {total_deducted:,.0f}'
            }), 400

        points_earned = int(amount // 1000) * 5
        now_iso       = datetime.utcnow().isoformat()

        if transaction_type == 'transfer':
            description = f"Transfer to {data.get('recipient', 'Unknown')}"
            if fee > 0:
                description += f" (Fee: PKR {fee:,.0f})"
            c.execute("""
                INSERT INTO dashboard_transactions
                    (account_number, transaction_type, description, amount,
                     recipient, status, created_at, category, fee)
                VALUES (%s, 'transfer', %s, %s, %s, 'completed', %s, %s, %s)
                RETURNING id
            """, (account_number, description, -total_deducted,
                  recipient_account, now_iso, category, fee))
        else:
            biller      = data.get('biller')
            description = f"{biller} Bill Payment"
            c.execute("""
                INSERT INTO dashboard_transactions
                    (account_number, transaction_type, description, amount,
                     biller, bill_id, status, created_at, category, fee)
                VALUES (%s, 'bill', %s, %s, %s, %s, 'completed', %s, %s, 0)
                RETURNING id
            """, (account_number, description, -amount, biller,
                  data.get('billId', 'N/A'), now_iso, category))

        transaction_id = c.fetchone()['id']

        # Log the fee for the admin Fee & Revenue panel (transfer_fees table,
        # queried by admin_routes/fees.py). Logged for every transfer,
        # including FinBud-to-FinBud transfers where fee is 0, so the ledger
        # reflects the full transfer volume, not just fee-generating ones.
        if transaction_type == 'transfer':
            fee_percentage = (fee / amount) if amount else 0.0
            c.execute("""
                INSERT INTO transfer_fees
                    (transaction_id, account_number, transfer_amount,
                     fee_amount, fee_percentage, created_at)
                VALUES (%s, %s, %s, %s, %s, %s)
            """, (transaction_id, account_number, amount, fee,
                  fee_percentage, now_iso))

        new_balance = user['balance'] - total_deducted
        new_points  = user['points'] + points_earned
        c.execute(
            "UPDATE dashboard_users SET balance=%s, points=%s WHERE account_number=%s",
            (new_balance, new_points, account_number)
        )

        # Insert transaction notification
        notif_msg = (
            f"PKR {amount:,.0f} sent to {data.get('recipient', 'Unknown')}. "
            f"Remaining balance: PKR {new_balance:,.0f}."
            if transaction_type == 'transfer'
            else f"Bill payment of PKR {amount:,.0f} to {data.get('biller', 'biller')} successful. "
                 f"Remaining balance: PKR {new_balance:,.0f}."
        )
        c.execute("""
            INSERT INTO notifications(account_number, message, notif_type, is_read, created_at)
            VALUES (%s, %s, 'transaction', FALSE, %s)
        """, (account_number, notif_msg, now_iso))

        conn.commit()
        release_db(conn)

        # Save billing reference for proactive pre-fill next time
        if transaction_type != 'transfer':
            try:
                save_paid_bill_ref(account_number, data.get('biller'), amount, data.get('billId'))
            except Exception as ref_err:
                print(f"Warning: could not save billing ref: {ref_err}")

        return jsonify({
            'success':        True,
            'transaction_id': transaction_id,
            'new_balance':    float(new_balance),
            'new_points':     new_points,
            'points_earned':  points_earned,
            'fee':            fee,
            'fee_applied':    fee > 0
        })

    except Exception as e:
        return jsonify({'success': False, 'message': str(e)}), 500


@app.route('/api/transaction/history', methods=['GET'])
def transaction_history():
    if 'user_id' not in session:
        return jsonify({'success': False, 'message': 'Not authenticated'}), 401

    try:
        account_number = session['account_number']
        limit          = request.args.get('limit', 10, type=int)

        conn = get_db()
        c    = conn.cursor()
        c.execute("""
            SELECT id, transaction_type, description, amount, created_at, category
            FROM dashboard_transactions
            WHERE account_number=%s
            ORDER BY created_at DESC
            LIMIT %s
        """, (account_number, limit))

        transactions = []
        for row in c.fetchall():
            date_obj       = datetime.fromisoformat(row['created_at'])
            formatted_date = date_obj.strftime('%b %d, %Y')
            transactions.append({
                'id':               row['id'],
                'date':             formatted_date,
                'description':      row['description'],
                'amount':           float(row['amount']),
                'transaction_type': row['transaction_type'],
                'category':         row['category']
            })

        release_db(conn)
        return jsonify({'success': True, 'transactions': transactions})

    except Exception as e:
        print(f"Transaction history error: {str(e)}")
        return jsonify({'success': False, 'message': str(e)}), 500


@app.route('/api/transaction/<int:transaction_id>/receipt', methods=['GET'])
def transaction_receipt(transaction_id):
    if 'user_id' not in session:
        return jsonify({'success': False, 'message': 'Not authenticated'}), 401

    try:
        account_number = session['account_number']
        conn = get_db()
        c    = conn.cursor()
        c.execute("""
            SELECT id, account_number, transaction_type, description, amount,
                   recipient, biller, bill_id, status, created_at, category, fee
            FROM dashboard_transactions
            WHERE id=%s AND account_number=%s
        """, (transaction_id, account_number))

        row = c.fetchone()
        release_db(conn)

        if not row:
            return jsonify({'success': False, 'message': 'Transaction not found'}), 404

        date_obj = datetime.fromisoformat(row['created_at'])

        receipt = {
            'transaction_id':   row['id'],
            'account_number':   row['account_number'],
            'transaction_type': row['transaction_type'],
            'description':      row['description'],
            'amount':           float(row['amount']),
            'recipient':        row['recipient'],
            'biller':           row['biller'],
            'bill_id':          row['bill_id'],
            'status':           row['status'],
            'category':         row['category'],
            'fee':              float(row['fee']) if row['fee'] is not None else 0.0,
            'date':             date_obj.strftime('%b %d, %Y'),
            'time':             date_obj.strftime('%I:%M %p'),
            'created_at':       row['created_at']
        }

        return jsonify({'success': True, 'receipt': receipt})

    except Exception as e:
        print(f"Transaction receipt error: {str(e)}")
        return jsonify({'success': False, 'message': str(e)}), 500


# ═══════════════════════════════════════════════════════════════════════════
# FINANCIAL INSIGHTS API
# ═══════════════════════════════════════════════════════════════════════════

@app.route('/api/financial/spending-category', methods=['GET'])
def spending_by_category():
    if 'user_id' not in session:
        return jsonify({'success': False, 'message': 'Not authenticated'}), 401

    try:
        account_number = session['account_number']
        conn = get_db()
        c    = conn.cursor()
        c.execute("""
            SELECT transaction_type, biller, description, amount
            FROM dashboard_transactions
            WHERE account_number=%s AND amount < 0
            ORDER BY created_at DESC
        """, (account_number,))

        transactions = c.fetchall()
        release_db(conn)

        provider_to_category = {
            provider.lower(): category.capitalize()
            for category, providers in BILL_PROVIDERS.items()
            for provider in providers
        }

        spending = {}
        for txn in transactions:
            txn_type = txn['transaction_type']
            biller   = txn['biller']
            amount   = abs(float(txn['amount']))

            if txn_type == 'bill':
                category = provider_to_category.get(biller.lower(), biller) if biller else 'Bill Payment'
            elif txn_type == 'transfer':
                category = 'Transfers'
            else:
                category = 'Other'

            spending[category] = spending.get(category, 0) + amount

        return jsonify({'success': True, 'spending_by_category': spending})

    except Exception as e:
        print(f"Financial reports error: {str(e)}")
        return jsonify({'success': False, 'message': str(e)}), 500


# ═══════════════════════════════════════════════════════════════════════════
# DASHBOARD DATA API
# ═══════════════════════════════════════════════════════════════════════════

@app.route('/api/dashboard/data', methods=['GET'])
def get_dashboard_data():
    if 'user_id' not in session:
        return jsonify({'success': False, 'message': 'Not authenticated'}), 401

    try:
        account_number = session['account_number']
        conn = get_db()
        c    = conn.cursor()

        c.execute(
            "SELECT name, balance, points, email, phone FROM dashboard_users WHERE account_number=%s",
            (account_number,)
        )
        user = c.fetchone()

        if not user:
            release_db(conn)
            return jsonify({'success': False, 'message': 'User not found'}), 404

        c.execute("""
            SELECT transaction_type, description, amount, created_at, status
            FROM dashboard_transactions
            WHERE account_number=%s
            ORDER BY created_at DESC
            LIMIT 10
        """, (account_number,))
        transactions = c.fetchall()
        release_db(conn)

        return jsonify({
            'success': True,
            'user': {
                'name':           user['name'],
                'balance':        float(user['balance']),
                'points':         user['points'],
                'email':          user['email'],
                'phone':          user['phone'],
                'account_number': account_number
            },
            'transactions': [
                {
                    'type':        t['transaction_type'],
                    'description': t['description'],
                    'amount':      float(t['amount']),
                    'date':        t['created_at'],
                    'status':      t['status']
                }
                for t in transactions
            ]
        })

    except Exception as e:
        return jsonify({'success': False, 'message': str(e)}), 500


# ═══════════════════════════════════════════════════════════════════════════
# MIGRATED FEATURES.PY ROUTES
# ═══════════════════════════════════════════════════════════════════════════

@app.route('/points/get', methods=['GET'])
def api_get_points():
    acc = request.args.get('account')
    return jsonify({"account": acc, "points": get_points(acc)})

@app.route('/points/add', methods=['POST'])
def api_add_points():
    data         = request.json
    acc          = data['account']
    pts          = int(data['points'])
    reason       = data.get('reason', 'no reason')
    due_date_str = data.get('due_date')

    if due_date_str:
        today    = datetime.now().date()
        due_date = datetime.strptime(due_date_str, "%Y-%m-%d").date()
        if today > due_date:
            log_late_payment(acc, reason, due_date_str)
            return jsonify({
                "success": False, "message": "Late payment - no points awarded",
                "account": acc, "points": get_points(acc)
            }), 200

    new_points = add_points(acc, pts, reason)
    return jsonify({"success": True, "account": acc, "points": new_points})

@app.route('/points/redeem', methods=['POST'])
def api_redeem():
    data = request.json
    acc  = data['account']
    cost = int(data['cost'])
    ok, pts = redeem_points(acc, cost)
    return jsonify({"success": ok, "remaining_points": pts})

@app.route('/bills/add', methods=['POST'])
def api_bills_add():
    data    = request.json
    bill_id = add_bill(data['account'], data['biller'], data['amount'], data['due_date'], data.get('ref'))
    return jsonify({"success": True, "bill_id": bill_id})

@app.route('/bills/pending', methods=['GET'])
def api_bills_pending():
    acc   = request.args.get('account')
    items = list_pending(acc)
    return jsonify({"account": acc, "pending": items})

@app.route('/reminders/run', methods=['GET'])
def api_reminders_run():
    today = request.args.get('today')
    out   = generate_reminders(today_str=today)
    return jsonify({"generated": out})

@app.route('/reminders/inbox', methods=['GET'])
def api_reminders_inbox():
    acc   = request.args.get('account')
    inbox = get_inbox(acc)
    return jsonify({"account": acc, "inbox": inbox})

@app.route('/insights/anomalies', methods=['GET'])
def api_anomalies():
    acc   = request.args.get('account')
    items = detect_anomalies(acc)
    return jsonify({"account": acc, "anomalies": items})

@app.route('/handoff/create', methods=['POST'])
def api_handoff_create():
    data      = request.json
    acc       = data['account']
    reason    = data.get('reason', 'user_requested_human')
    ticket_id = create_ticket(acc, reason)
    return jsonify({"status": "queued", "ticket_id": ticket_id})

@app.route('/handoff/queue', methods=['GET'])
def api_handoff_queue():
    status_q = request.args.get('status', 'pending')
    out      = queue_list(status=status_q)
    return jsonify({"tickets": out})

@app.route('/handoff/claim', methods=['POST'])
def api_handoff_claim():
    data      = request.json
    ticket_id = int(data['ticket_id'])
    banker_id = data.get('banker_id', 'banker-1')
    ok        = claim(ticket_id, banker_id)
    return jsonify({"success": ok})

@app.route('/handoff/resolve', methods=['POST'])
def api_handoff_resolve():
    data      = request.json
    ticket_id = int(data['ticket_id'])
    ok        = resolve(ticket_id)
    return jsonify({"success": ok})

@app.route('/handoff/cancel', methods=['POST'])
def api_handoff_cancel():
    data      = request.json
    ticket_id = int(data['ticket_id'])
    ok        = cancel(ticket_id)
    return jsonify({"success": ok})

@app.route('/handoff/status', methods=['GET'])
def api_handoff_status():
    acc = request.args.get('account')
    st  = status(acc)
    return jsonify({"account": acc, **st})

@app.route('/emergency/trigger', methods=['POST'])
def api_emergency_trigger():
    data             = request.json
    acc              = data['account']
    entered_password = data['password']
    real_password    = "mypassword"
    result           = trigger_emergency(acc, real_password, entered_password)
    return jsonify(result)

@app.route('/api/cards/check', methods=['GET'])
def api_cards_check():
    if 'user_id' not in session:
        return jsonify({'success': False, 'message': 'Not authenticated'}), 401
    account_number = session['account_number']
    has_card       = has_registered_card(account_number)
    return jsonify({'success': True, 'account': account_number, 'has_card': has_card})

@app.route('/api/cards/list', methods=['GET'])
def api_cards_list():
    if 'user_id' not in session:
        return jsonify({'success': False, 'message': 'Not authenticated'}), 401
    account_number = session['account_number']
    cards          = list_cards(account_number)
    return jsonify({'success': True, 'account': account_number, 'cards': cards})


# ═══════════════════════════════════════════════════════════════════════════
# REWARDS REDEMPTION API (3-Tier)
# ═══════════════════════════════════════════════════════════════════════════

@app.route('/api/rewards/redeem', methods=['POST'])
def redeem_reward():
    if 'user_id' not in session:
        return jsonify({'success': False, 'message': 'Not authenticated'}), 401

    try:
        data           = request.json
        tier_name      = data.get('tier', '').strip()
        product_id     = data.get('product_id', '').strip()
        account_number = session['account_number']

        tier = get_redemption_tier(tier_name)
        if not tier:
            return jsonify({
                'success': False,
                'message': f'Invalid tier. Choose from: {", ".join(REDEMPTION_TIERS.keys())}'
            }), 400

        points_cost = tier['points_cost']
        pkr_value   = tier['pkr_value']

        product = None
        if tier_name == 'product_purchase':
            if not product_id:
                return jsonify({
                    'success':            False,
                    'message':            'product_id is required for product_purchase tier.',
                    'available_products': MOCK_PRODUCT_CATALOGUE
                }), 400
            product = get_product(product_id)
            if not product:
                return jsonify({
                    'success':            False,
                    'message':            f'Product {product_id} not found.',
                    'available_products': MOCK_PRODUCT_CATALOGUE
                }), 404
            pkr_value = product['pkr_value']

        success, remaining_points = redeem_points(account_number, points_cost)
        if not success:
            current_points = remaining_points
            return jsonify({
                'success':         False,
                'message':         f'Insufficient points. You have {current_points} pts, need {points_cost} pts.',
                'current_points':  current_points,
                'required_points': points_cost
            }), 400

        conn = get_db()
        c    = conn.cursor()

        c.execute(
            "SELECT balance FROM dashboard_users WHERE account_number=%s",
            (account_number,)
        )
        new_balance = float(c.fetchone()['balance'])

        if tier_name == 'cash_voucher':
            new_balance += pkr_value
            c.execute(
                "UPDATE dashboard_users SET balance=%s WHERE account_number=%s",
                (new_balance, account_number)
            )
            description = f'Cash Voucher Redeemed — PKR {pkr_value} credited'

        elif tier_name == 'product_purchase':
            description = f'Product Redeemed — {product["name"]} (PKR {pkr_value})'

        elif tier_name == 'investment_pocket':
            new_balance += pkr_value
            c.execute(
                "UPDATE dashboard_users SET balance=%s WHERE account_number=%s",
                (new_balance, account_number)
            )
            description = f'Investment Pocket Transfer — PKR {pkr_value} credited'

        c.execute("""
            INSERT INTO redemptions(account_number, points_used, reward_value, created_at)
            VALUES (%s, %s, %s, %s)
        """, (account_number, points_cost, pkr_value, datetime.utcnow().isoformat()))

        c.execute("""
            INSERT INTO dashboard_transactions
                (account_number, transaction_type, description, amount, status, created_at)
            VALUES (%s, 'redemption', %s, %s, 'completed', %s)
        """, (account_number, description, pkr_value, datetime.utcnow().isoformat()))

        conn.commit()
        release_db(conn)

        return jsonify({
            'success':          True,
            'tier':             tier_name,
            'points_used':      points_cost,
            'pkr_value':        pkr_value,
            'remaining_points': remaining_points,
            'new_balance':      float(new_balance),
            'description':      description,
            'product':          product
        })

    except Exception as e:
        print(f"Redemption error: {str(e)}")
        return jsonify({'success': False, 'message': str(e)}), 500


# ═══════════════════════════════════════════════════════════════════════════
# BILL PROVIDERS API
# ═══════════════════════════════════════════════════════════════════════════

@app.route('/api/bills/providers', methods=['GET'])
def get_bill_providers():
    if 'user_id' not in session:
        return jsonify({'success': False, 'message': 'Not authenticated'}), 401

    category = request.args.get('category', '').strip().lower()

    if category:
        providers = BILL_PROVIDERS.get(category)
        if not providers:
            return jsonify({
                'success': False,
                'message': f'Unknown category. Valid options: {", ".join(BILL_PROVIDERS.keys())}'
            }), 400
        return jsonify({'success': True, 'category': category, 'providers': providers})

    return jsonify({'success': True, 'providers': BILL_PROVIDERS})


@app.route('/api/bills/saved-ref', methods=['GET'])
def get_saved_bill_ref():
    if 'user_id' not in session:
        return jsonify({'success': False, 'message': 'Not authenticated'}), 401

    provider = request.args.get('provider', '').strip()
    if not provider:
        return jsonify({'success': False, 'message': 'provider query param is required'}), 400

    account_number = session['account_number']
    saved_ref      = get_saved_biller_ref(account_number, provider)

    if saved_ref:
        return jsonify({'success': True,  'has_saved_ref': True,  'ref': saved_ref, 'provider': provider})
    return jsonify(    {'success': True,  'has_saved_ref': False, 'ref': None,      'provider': provider})


# ══════════════════════════════════════════════════════════════════════════════
# v3  — Financial Advisor + Digital Wallet endpoints
# Each route uses get_pg_conn() / release_pg_conn() from features.py so it
# shares the same PostgreSQL pool.  No existing routes are touched.
# ══════════════════════════════════════════════════════════════════════════════

# ─────────────────────────────────────────────────────────────────────────────
# FINANCIAL ADVISOR  — Income Logging
# ─────────────────────────────────────────────────────────────────────────────

@app.route('/api/income/log', methods=['POST'])
def log_income():
    """
    Logs one income entry:
    • inserts into income_transactions  (for advisor analytics)
    • inserts into dashboard_transactions as a positive-amount 'income' row
      (so it appears in transaction history & receipts)
    • credits dashboard_users.balance
    Body:  { amount, source, note }
    Reply: { success, new_balance, transaction_id }
    """
    if 'user_id' not in session:
        return jsonify({'success': False, 'message': 'Not authenticated'}), 401

    try:
        data           = request.json
        amount         = float(data.get('amount', 0))
        source         = data.get('source', 'Other').strip()
        note           = data.get('note', '').strip()
        account_number = session['account_number']

        if amount <= 0:
            return jsonify({'success': False, 'message': 'Amount must be positive'}), 400

        now_iso = datetime.utcnow().isoformat()
        conn    = get_pg_conn(); c = conn.cursor()

        # 1. Record in income_transactions for advisor analytics
        c.execute("""
            INSERT INTO income_transactions(account_number, amount, source, note, created_at)
            VALUES (%s, %s, %s, %s, %s)
        """, (account_number, amount, source, note, now_iso))

        # 2. Record in dashboard_transactions so it shows in history + receipts
        c.execute("""
            INSERT INTO dashboard_transactions
                (account_number, transaction_type, description, amount, status, created_at)
            VALUES (%s, 'income', %s, %s, 'completed', %s)
            RETURNING id
        """, (account_number, f"Income — {source}", amount, now_iso))
        transaction_id = c.fetchone()['id']

        # 3. Credit balance
        c.execute("""
            UPDATE dashboard_users
            SET balance = balance + %s
            WHERE account_number = %s
        """, (amount, account_number))

        # 4. Read updated balance to return to frontend
        c.execute(
            "SELECT balance FROM dashboard_users WHERE account_number=%s",
            (account_number,)
        )
        new_balance = float(c.fetchone()['balance'])

        conn.commit(); release_pg_conn(conn)

        return jsonify({
            'success':        True,
            'new_balance':    new_balance,
            'transaction_id': transaction_id
        })

    except Exception as e:
        print(f"[log_income] error: {e}")
        return jsonify({'success': False, 'message': str(e)}), 500


# ─────────────────────────────────────────────────────────────────────────────
# FINANCIAL ADVISOR  — Analytics endpoints
# ─────────────────────────────────────────────────────────────────────────────

@app.route('/api/financial/income-vs-expense', methods=['GET'])
def income_vs_expense():
    """
    This calendar month's income, expenses, and net for the logged-in user.
    Reply: { success, income, expenses, net }
    """
    if 'user_id' not in session:
        return jsonify({'success': False, 'message': 'Not authenticated'}), 401

    try:
        data = get_income_vs_expense(session['account_number'])
        return jsonify({'success': True, **data})
    except Exception as e:
        print(f"[income_vs_expense] error: {e}")
        return jsonify({'success': False, 'message': str(e)}), 500


@app.route('/api/financial/income-by-source', methods=['GET'])
def income_by_source():
    """
    This calendar month's income grouped by source.
    Reply: { success, income_by_source: { "Salary": 50000, ... } }
    """
    if 'user_id' not in session:
        return jsonify({'success': False, 'message': 'Not authenticated'}), 401

    try:
        breakdown = get_income_by_source(session['account_number'])
        return jsonify({'success': True, 'income_by_source': breakdown})
    except Exception as e:
        print(f"[income_by_source] error: {e}")
        return jsonify({'success': False, 'message': str(e)}), 500


@app.route('/api/financial/monthly-trend', methods=['GET'])
def monthly_trend():
    """
    Income vs. expenses for each of the last 6 calendar months.
    Reply: { success, trend: [{ month, income, expenses }, ...] }
    """
    if 'user_id' not in session:
        return jsonify({'success': False, 'message': 'Not authenticated'}), 401

    try:
        trend = get_monthly_trend(session['account_number'])
        return jsonify({'success': True, 'trend': trend})
    except Exception as e:
        print(f"[monthly_trend] error: {e}")
        return jsonify({'success': False, 'message': str(e)}), 500


@app.route('/api/financial/utility-usage', methods=['GET'])
def utility_usage():
    """
    Placeholder — returns a clean 'coming soon' response.
    The frontend already handles this gracefully (shows a roadmap note).
    A real implementation would query a biller integration for unit data.
    Reply: { success: false, message }  →  frontend shows placeholder card.
    """
    if 'user_id' not in session:
        return jsonify({'success': False, 'message': 'Not authenticated'}), 401

    # Returning success=False causes the frontend to show the "on the roadmap"
    # placeholder text — which is the correct UX until biller integration exists.
    return jsonify({
        'success': False,
        'message': 'Utility unit tracking requires a biller integration (roadmap item).'
    })


# ─────────────────────────────────────────────────────────────────────────────
# DIGITAL WALLET  — Card Management
# ─────────────────────────────────────────────────────────────────────────────

@app.route('/api/cards/add', methods=['POST'])
def add_card():
    """
    Adds a card to the user's wallet.
    Only the last 4 digits are stored (same masking pattern as the existing
    cards table); full tokenization is the post-competition upgrade path.
    Body:  { cardholder_name, card_number (16-digit raw), expiry, nickname }
    Reply: { success, card_id }
    """
    if 'user_id' not in session:
        return jsonify({'success': False, 'message': 'Not authenticated'}), 401

    try:
        data           = request.json
        raw_number     = str(data.get('card_number', '')).replace(' ', '')
        cardholder     = data.get('cardholder_name', '').strip()
        expiry         = data.get('expiry', '').strip()
        nickname       = data.get('nickname', '').strip()
        account_number = session['account_number']

        if len(raw_number) != 16 or not raw_number.isdigit():
            return jsonify({'success': False, 'message': 'Card number must be exactly 16 digits'}), 400

        # Store only last 4 digits — raw PAN never persists on server
        masked_number = raw_number[-4:]

        conn = get_pg_conn(); c = conn.cursor()
        c.execute("""
            INSERT INTO cards(account_number, card_number, cardholder_name, expiry, nickname, status)
            VALUES (%s, %s, %s, %s, %s, 'active')
            RETURNING id
        """, (account_number, masked_number, cardholder, expiry, nickname))
        card_id = c.fetchone()['id']
        conn.commit(); release_pg_conn(conn)

        return jsonify({'success': True, 'card_id': card_id})

    except Exception as e:
        print(f"[add_card] error: {e}")
        return jsonify({'success': False, 'message': str(e)}), 500


# ─────────────────────────────────────────────────────────────────────────────
# DIGITAL WALLET  — Bank Account Linking
# ─────────────────────────────────────────────────────────────────────────────

@app.route('/api/wallet/bank-accounts', methods=['GET'])
def wallet_bank_accounts():
    """
    Returns all bank accounts linked (or pending) for the logged-in user.
    Reply: { success, accounts: [{ bank, masked_iban, status }, ...] }
    """
    if 'user_id' not in session:
        return jsonify({'success': False, 'message': 'Not authenticated'}), 401

    try:
        account_number = session['account_number']
        conn = get_pg_conn(); c = conn.cursor()
        c.execute("""
            SELECT bank_name, iban, status
            FROM bank_accounts
            WHERE account_number=%s
            ORDER BY linked_at DESC
        """, (account_number,))
        rows = c.fetchall(); release_pg_conn(conn)

        accounts = [
            {
                'bank':        r['bank_name'],
                # Mask the IBAN: show country+check digits + last 4 only
                'masked_iban': f"{r['iban'][:4]} **** **** **** {r['iban'][-4:]}",
                'status':      r['status']
            }
            for r in rows
        ]
        return jsonify({'success': True, 'accounts': accounts})

    except Exception as e:
        print(f"[wallet_bank_accounts] error: {e}")
        return jsonify({'success': False, 'message': str(e)}), 500


@app.route('/api/wallet/link-bank', methods=['POST'])
def link_bank():
    """
    Records a bank-linking request with status='pending'.
    Real OTP / Open Banking consent flow is the post-competition upgrade path
    (1LINK Open API Gateway + SBP TPP registration).
    Body:  { bank, iban }
    Reply: { success, message }
    """
    if 'user_id' not in session:
        return jsonify({'success': False, 'message': 'Not authenticated'}), 401

    try:
        data           = request.json
        bank           = data.get('bank', '').strip()
        iban           = data.get('iban', '').strip().upper()
        account_number = session['account_number']

        # Basic IBAN validation (per mentor's slot-filling feedback: exactly 24 chars)
        if not bank:
            return jsonify({'success': False, 'message': 'Bank name is required'}), 400
        if len(iban) != 24:
            return jsonify({'success': False, 'message': 'IBAN must be exactly 24 characters'}), 400

        conn = get_pg_conn(); c = conn.cursor()
        c.execute("""
            INSERT INTO bank_accounts(account_number, bank_name, iban, status, linked_at)
            VALUES (%s, %s, %s, 'pending', %s)
        """, (account_number, bank, iban, datetime.utcnow().isoformat()))
        conn.commit(); release_pg_conn(conn)

        return jsonify({
            'success': True,
            'message': f'{bank} link request received — pending consent verification.'
        })

    except Exception as e:
        print(f"[link_bank] error: {e}")
        return jsonify({'success': False, 'message': str(e)}), 500


# ─────────────────────────────────────────────────────────────────────────────
# DIGITAL WALLET  — Other Assets (Net Worth)
# ─────────────────────────────────────────────────────────────────────────────

@app.route('/api/wallet/other-assets', methods=['GET'])
def get_other_assets():
    """
    Returns the user's manually-entered 'other assets' total.
    Used by the Net Worth calculation in the Wallet view.
    Reply: { success, amount }
    """
    if 'user_id' not in session:
        return jsonify({'success': False, 'message': 'Not authenticated'}), 401

    try:
        conn = get_pg_conn(); c = conn.cursor()
        c.execute(
            "SELECT other_assets FROM dashboard_users WHERE account_number=%s",
            (session['account_number'],)
        )
        row = c.fetchone(); release_pg_conn(conn)
        amount = float(row['other_assets']) if row and row['other_assets'] else 0.0
        return jsonify({'success': True, 'amount': amount})

    except Exception as e:
        print(f"[get_other_assets] error: {e}")
        return jsonify({'success': False, 'message': str(e)}), 500


@app.route('/api/wallet/other-assets', methods=['POST'])
def set_other_assets():
    """
    Saves the user's 'other assets' figure.
    Body:  { amount }
    Reply: { success, amount }
    """
    if 'user_id' not in session:
        return jsonify({'success': False, 'message': 'Not authenticated'}), 401

    try:
        amount = float(request.json.get('amount', 0))
        if amount < 0:
            return jsonify({'success': False, 'message': 'Amount cannot be negative'}), 400

        conn = get_pg_conn(); c = conn.cursor()
        c.execute(
            "UPDATE dashboard_users SET other_assets=%s WHERE account_number=%s",
            (amount, session['account_number'])
        )
        conn.commit(); release_pg_conn(conn)
        return jsonify({'success': True, 'amount': amount})

    except Exception as e:
        print(f"[set_other_assets] error: {e}")
        return jsonify({'success': False, 'message': str(e)}), 500


# ══════════════════════════════════════════════════════════════════════════════
# v4  — Credit Intelligence (C.I.) API
# ══════════════════════════════════════════════════════════════════════════════

@app.route('/api/credit-score', methods=['GET'])
def credit_score():
    """
    Returns the computed credit score for the logged-in user.

    Response shape:
    {
        "success": true,
        "score":   720,
        "label":   "Good",
        "color":   "#84cc16",
        "advice":  "...",
        "breakdown": {
            "late_payments":   0,
            "balance":         75000.00,
            "transactions_6m": 14,
            "reward_points":   350
        }
    }
    """
    if 'user_id' not in session:
        return jsonify({'success': False, 'message': 'Not authenticated'}), 401

    try:
        result = generate_credit_score(session['account_number'])
        return jsonify({'success': True, **result})
    except Exception as e:
        print(f"[credit_score] error: {e}")
        return jsonify({'success': False, 'message': str(e)}), 500


# ══════════════════════════════════════════════════════════════════════════════
# v5  — Notifications, Expense Categories, Updated Safe-to-Spend
# ══════════════════════════════════════════════════════════════════════════════

@app.route('/api/notifications', methods=['GET'])
def get_notifications():
    """
    Returns the latest notifications for the logged-in user.
    Query param: ?limit=20  (default 20)
    Each notification includes message, type, is_read, created_at.
    """
    if 'user_id' not in session:
        return jsonify({'success': False, 'message': 'Not authenticated'}), 401

    try:
        account_number = session['account_number']
        limit          = request.args.get('limit', 20, type=int)

        conn = get_db(); c = conn.cursor()
        c.execute("""
            SELECT id, message, notif_type, is_read, created_at
            FROM notifications
            WHERE account_number=%s
            ORDER BY created_at DESC
            LIMIT %s
        """, (account_number, limit))
        rows = c.fetchall(); release_db(conn)

        notifications = [
            {
                'id':         r['id'],
                'message':    r['message'],
                'type':       r['notif_type'],
                'is_read':    r['is_read'],
                'created_at': r['created_at']
            }
            for r in rows
        ]
        return jsonify({'success': True, 'notifications': notifications})

    except Exception as e:
        print(f"[get_notifications] error: {e}")
        return jsonify({'success': False, 'message': str(e)}), 500


@app.route('/api/notifications/mark-read', methods=['POST'])
def mark_notifications_read():
    """
    Marks all notifications as read for the logged-in user.
    """
    if 'user_id' not in session:
        return jsonify({'success': False, 'message': 'Not authenticated'}), 401

    try:
        conn = get_db(); c = conn.cursor()
        c.execute(
            "UPDATE notifications SET is_read=TRUE WHERE account_number=%s",
            (session['account_number'],)
        )
        conn.commit(); release_db(conn)
        return jsonify({'success': True})

    except Exception as e:
        return jsonify({'success': False, 'message': str(e)}), 500


@app.route('/api/transaction/categories', methods=['GET'])
def get_expense_categories():
    """
    Returns the list of valid expense categories for the frontend dropdowns.
    """
    if 'user_id' not in session:
        return jsonify({'success': False, 'message': 'Not authenticated'}), 401

    return jsonify({'success': True, 'categories': EXPENSE_CATEGORIES})


@app.route('/api/financial/spending-by-category', methods=['GET'])
def spending_by_category_detailed():
    """
    Returns this month's spending grouped by the new category column.
    Used for the detailed expense breakdown chart in Financial Advisor.
    """
    if 'user_id' not in session:
        return jsonify({'success': False, 'message': 'Not authenticated'}), 401

    try:
        account_number = session['account_number']
        now            = datetime.utcnow()
        month_start    = datetime(now.year, now.month, 1).isoformat()

        conn = get_db(); c = conn.cursor()
        c.execute("""
            SELECT
                COALESCE(category, 'Other') AS category,
                COALESCE(SUM(ABS(amount)), 0) AS total
            FROM dashboard_transactions
            WHERE account_number=%s AND amount < 0 AND created_at >= %s
            GROUP BY category
            ORDER BY total DESC
        """, (account_number, month_start))
        rows = c.fetchall(); release_db(conn)

        breakdown = {r['category']: round(float(r['total']), 2) for r in rows}
        return jsonify({'success': True, 'breakdown': breakdown})

    except Exception as e:
        return jsonify({'success': False, 'message': str(e)}), 500


if __name__ == '__main__':
    app.run(debug=True, host='0.0.0.0', port=5000)