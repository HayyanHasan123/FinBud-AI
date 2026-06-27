# app.py  –  FinBud AI (PostgreSQL Edition — COMPLETE)
# ─────────────────────────────────────────────────────────────────────────────
# PostgreSQL migration changes vs SQLite version:
#   1. `sqlite3` removed; `psycopg2` + connection pool added.
#   2. `get_db()` returns a psycopg2 connection from the pool.
#   3. All SQL placeholders changed from ? → %s (PostgreSQL standard).
#   4. `c.lastrowid` replaced with RETURNING id + fetchone()['id'].
#   5. `conn.row_factory` replaced with psycopg2.extras.RealDictCursor
#      so rows remain dict-like (row['column_name']) throughout the code.
#   6. `conn.close()` replaced with release_db(conn) everywhere.
#   7. DATABASE_URL loaded from .env via python-dotenv.
#   8. INTEGER PRIMARY KEY AUTOINCREMENT → SERIAL PRIMARY KEY.
#   9. REAL → NUMERIC(15,2) for money fields.
#
# All routes, logic, variable names, and function names from the SQLite
# version are preserved. Nothing has been removed.
# ─────────────────────────────────────────────────────────────────────────────

from flask import Flask, render_template, request, jsonify, session, redirect, url_for
from werkzeug.security import generate_password_hash, check_password_hash

# ── PostgreSQL driver + connection pool ───────────────────────────────────────
import psycopg2
import psycopg2.extras                          # for RealDictCursor (dict-like rows)
from psycopg2 import pool as psycopg2_pool      # ThreadedConnectionPool

# ── load .env so DATABASE_URL is available via os.getenv ──────────────────────
from dotenv import load_dotenv
load_dotenv()

from datetime import datetime
import secrets
import sys
import os
import io

from features import (
    init_db, log_late_payment, get_points, add_points, redeem_points,
    add_bill, save_paid_bill_ref, mark_paid, list_pending, generate_reminders, get_inbox,
    detect_anomalies, create_ticket, queue_list, claim, resolve, cancel,
    status, trigger_emergency, has_registered_card, list_cards,
    BILL_PROVIDERS, REDEMPTION_TIERS, MOCK_PRODUCT_CATALOGUE,
    validate_provider, get_saved_biller_ref, get_product, get_redemption_tier
)

from nlp_module import BankAIConversation

# Speech recognition import
try:
    import speech_recognition as sr
    SPEECH_RECOGNITION_AVAILABLE = True
except ImportError:
    SPEECH_RECOGNITION_AVAILABLE = False
    print("Warning: speech_recognition not installed.")

app = Flask(__name__,
            static_folder='../frontend/static',
            template_folder='../frontend/templates')
app.secret_key = secrets.token_hex(32)

# Initialize NLP chatbot engine
chatbot = BankAIConversation()

# ── PostgreSQL connection pool ─────────────────────────────────────────────────
DATABASE_URL = os.getenv("DATABASE_URL")
if not DATABASE_URL:
    sys.exit("❌  DATABASE_URL not set. Check your .env file.")

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


# ── Schema initialisation ──────────────────────────────────────────────────────
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
        language        VARCHAR(10)   DEFAULT 'en'
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

    conn.commit()
    release_db(conn)


# Initialize tables from both modules
init_user_tables()
init_db()


# ============= TEMPLATE ROUTES =============
@app.route('/')
def index():
    return render_template('index.html')

@app.route('/dashboard')
def dashboard():
    if 'user_id' not in session:
        return redirect(url_for('index'))
    return render_template('dashboard.html')

@app.route('/chat')
def chat():
    if 'user_id' not in session:
        return redirect(url_for('index'))
    return render_template('chat.html')


# ============= AUTHENTICATION API =============
@app.route('/api/auth/register', methods=['POST'])
def register():
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
                (account_number, name, email, password_hash, phone, balance, points, created_at)
            VALUES (%s, %s, %s, %s, %s, 50000, 100, %s)
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
    try:
        data     = request.json
        email    = data.get('email')
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

        if not user or not check_password_hash(user['password_hash'], password):
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


@app.route('/api/auth/logout', methods=['POST'])
def logout():
    session.clear()
    return jsonify({'success': True, 'message': 'Logged out successfully'})


# ============= CHATBOT API =============
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

        conn = get_db()
        c    = conn.cursor()
        c.execute(
            "SELECT name, balance, points, password_hash FROM dashboard_users WHERE account_number=%s",
            (account_number,)
        )
        user = c.fetchone()

        if not user:
            release_db(conn)
            return jsonify({'success': False, 'message': 'User not found'}), 404

        conversation_context = session.get('conversation_context', {})
        nlp_result = chatbot.process_message(user_message, conversation_context)

        intent   = nlp_result['intent']
        language = nlp_result['language']
        entities = nlp_result.get('entities', {})

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
            else:
                attempts -= 1
                if attempts > 0:
                    ai_response = chatbot.responses['emergency_password_incorrect'][language].format(attempts=attempts)
                    session['conversation_context'] = {
                        'awaiting_emergency_password': True,
                        'emergency_attempts': attempts
                    }
                else:
                    ai_response = chatbot.responses['emergency_failed'][language]
                    session['conversation_context'] = {}

            c.execute("""
                INSERT INTO chat_history(account_number, user_message, ai_response, intent, created_at)
                VALUES (%s, %s, %s, %s, %s)
            """, (account_number, "[Password verification]", ai_response, 'emergency',
                  datetime.utcnow().isoformat()))
            conn.commit()
            release_db(conn)

            return jsonify({
                'success':    True,
                'ai_response': ai_response,
                'intent':     'emergency',
                'language':   language
            })

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
                    'language':   language
                })

            if original_intent == 'transfer_money':
                amount            = entities.get('amount')
                recipient         = entities.get('recipient')
                recipient_account = entities.get('account_number')

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
                            (account_number, transaction_type, description, amount, recipient, status, created_at)
                        VALUES (%s, 'transfer', %s, %s, %s, 'completed', %s)
                    """, (account_number, f"Transfer to {recipient}", -amount,
                          recipient_account, datetime.utcnow().isoformat()))
                    conn.commit()

                    ai_response = chatbot.responses['transfer_success'][language].format(
                        amount=amount, recipient=recipient,
                        balance=new_balance, points=points_earned
                    )
                    session['conversation_context'] = {}

            elif original_intent == 'pay_bill':
                bill_type    = entities.get('bill_type')
                amount       = entities.get('amount')
                bill_account = entities.get('account_number')

                if user['balance'] < amount:
                    ai_response = chatbot.responses['insufficient_funds'][language].format(balance=user['balance'])
                    session['conversation_context'] = {
                        'current_flow':             'pay_bill',
                        'bill_type':                bill_type,
                        'amount':                   amount,
                        'account_number':           bill_account,
                        'insufficient_funds_retry': True
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
                          bill_type, bill_account, datetime.utcnow().isoformat()))
                    conn.commit()

                    ai_response = chatbot.responses['bill_payment_success'][language].format(
                        bill_type=bill_type, amount=amount,
                        balance=new_balance, points=points_earned
                    )
                    session['conversation_context'] = {}

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
                'language':   language
            })

        # ── context management ────────────────────────────────────────────────
        if nlp_result.get('awaiting_emergency_password'):
            session['conversation_context'] = {
                'awaiting_emergency_password': True,
                'emergency_attempts': nlp_result.get('emergency_attempts', 3)
            }
        elif nlp_result.get('awaiting_password'):
            session['conversation_context'] = {
                'awaiting_password': True,
                'original_intent':  nlp_result.get('original_intent'),
                'pending_entities': nlp_result.get('pending_entities', {})
            }
        elif nlp_result.get('current_flow'):
            context = {'current_flow': nlp_result['current_flow']}
            for key in ['amount', 'recipient', 'bill_type', 'bill_reference',
                        'redemption_choice', 'account_number']:
                if key in nlp_result:
                    context[key] = nlp_result[key]
            session['conversation_context'] = context
        else:
            session['conversation_context'] = {}

        ai_response = nlp_result.get('ai_response')

        if intent == 'check_balance':
            balance     = user['balance']
            template    = chatbot.responses['check_balance'][language]
            ai_response = template.format(balance=balance)

        elif intent == 'check_rewards':
            points      = user['points']
            template    = chatbot.responses['check_rewards'][language]
            ai_response = template.format(points=points)

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
            'awaiting_emergency_password': awaiting_emergency_pw
        })

    except Exception as e:
        print(f"Chat error: {str(e)}")
        return jsonify({'success': False, 'message': 'An error occurred processing your message'}), 500


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


# ============= USER API =============
@app.route('/api/user/data', methods=['GET'])
def get_user_data():
    if 'user_id' not in session:
        return jsonify({'success': False, 'message': 'Not authenticated'}), 401

    try:
        account_number = session['account_number']
        conn = get_db()
        c    = conn.cursor()
        c.execute("""
            SELECT account_number, name, email, phone, balance, points
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
            'email':   user['email'],
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
        c.execute("SELECT password_hash FROM dashboard_users WHERE id=%s", (user_id,))
        user = c.fetchone()
        release_db(conn)

        if not user:
            return jsonify({'success': False, 'message': 'User not found'}), 404

        if check_password_hash(user['password_hash'], password):
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

        if len(new_password) < 4:
            return jsonify({'success': False, 'message': 'New password must be at least 4 characters'}), 400

        user_id = session['user_id']
        conn    = get_db()
        c       = conn.cursor()
        c.execute("SELECT password_hash FROM dashboard_users WHERE id=%s", (user_id,))
        user = c.fetchone()

        if not user or not check_password_hash(user['password_hash'], current_password):
            release_db(conn)
            return jsonify({'success': False, 'message': 'Current password is incorrect'}), 401

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


# ============= TRANSACTION API =============
@app.route('/api/transaction/create', methods=['POST'])
def create_transaction():
    if 'user_id' not in session:
        return jsonify({'success': False, 'message': 'Not authenticated'}), 401

    try:
        data             = request.json
        account_number   = session['account_number']
        transaction_type = data.get('type')
        amount           = float(data.get('amount'))

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

        if user['balance'] < amount:
            release_db(conn)
            return jsonify({'success': False, 'message': 'Insufficient funds'}), 400

        points_earned = int(amount // 1000) * 5

        if transaction_type == 'transfer':
            description       = f"Transfer to {data.get('recipient', 'Unknown')}"
            recipient_account = data.get('recipient_account', 'N/A')
            c.execute("""
                INSERT INTO dashboard_transactions
                    (account_number, transaction_type, description, amount, recipient, status, created_at)
                VALUES (%s, 'transfer', %s, %s, %s, 'completed', %s)
                RETURNING id
            """, (account_number, description, -amount, recipient_account,
                  datetime.utcnow().isoformat()))
        else:
            biller      = data.get('biller')
            description = f"{biller} Bill Payment"
            c.execute("""
                INSERT INTO dashboard_transactions
                    (account_number, transaction_type, description, amount, biller, bill_id, status, created_at)
                VALUES (%s, 'bill', %s, %s, %s, %s, 'completed', %s)
                RETURNING id
            """, (account_number, description, -amount, biller,
                  data.get('billId', 'N/A'), datetime.utcnow().isoformat()))

        transaction_id = c.fetchone()['id']

        new_balance = user['balance'] - amount
        new_points  = user['points'] + points_earned
        c.execute(
            "UPDATE dashboard_users SET balance=%s, points=%s WHERE account_number=%s",
            (new_balance, new_points, account_number)
        )
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
            'points_earned':  points_earned
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
            SELECT id, transaction_type, description, amount, created_at
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
                'id':          row['id'],
                'date':        formatted_date,
                'description': row['description'],
                'amount':      float(row['amount'])
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
                   recipient, biller, bill_id, status, created_at
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
            'date':             date_obj.strftime('%b %d, %Y'),
            'time':             date_obj.strftime('%I:%M %p'),
            'created_at':       row['created_at']
        }

        return jsonify({'success': True, 'receipt': receipt})

    except Exception as e:
        print(f"Transaction receipt error: {str(e)}")
        return jsonify({'success': False, 'message': str(e)}), 500


# ============= FINANCIAL INSIGHTS API =============
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


# ============= DASHBOARD DATA API =============
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


# ============= MIGRATED FEATURES.PY ROUTES =============
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


# ============= REWARDS REDEMPTION API (3-Tier) =============
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
        new_balance = c.fetchone()['balance']

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


# ============= BILL PROVIDERS API =============
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


if __name__ == '__main__':
    app.run(debug=True, host='0.0.0.0', port=5000)
