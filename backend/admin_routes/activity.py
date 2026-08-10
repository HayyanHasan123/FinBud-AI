"""
admin_routes/activity.py — User Activity Log (/admin/activity), admin only.

Matches UserActivityLog.jsx exactly:
  GET /api/admin/activity/search-users
  GET /api/admin/activity/<account_number>/chat
  GET /api/admin/activity/<account_number>/transactions
  GET /api/admin/activity/<account_number>/logins
  GET /api/admin/activity/<account_number>/receipt/<txn_id>

Requires chat_history.sender / chat_history.engine and
dashboard_transactions.anomaly_flagged to exist — these were assigned to
admin_tables.py; if they don't exist yet, the /chat and /transactions
routes below will error until that migration runs.

FLAG: the /logins route needs a customer_login_log table. Nobody else
owns this, so it's created here — but the existing /api/auth/login route
in app.py does NOT currently write to it. Until someone instruments that
route, this will correctly return an empty list rather than error, which
is honest, not broken — the frontend already shows an empty state for it.
"""

from flask import Blueprint, request, jsonify, session
from datetime import datetime
import math

from features import get_pg_conn, release_pg_conn

activity_bp = Blueprint('activity', __name__, url_prefix='/api/admin/activity')

PAGE_SIZE = 20

# A gap of this many minutes (or more) between one chat_history row and the
# next, for the same account, is treated as the end of one conversation and
# the start of a new one. There's no session_id column to group by, so this
# is inferred from timestamps — same approach used to decide "still the same
# conversation" anywhere else timestamps are the only signal available.
SESSION_GAP_MINUTES = 30


def _group_into_sessions(rows):
    """rows: chat_history dicts for one account, ordered ASC by created_at.
    Returns one entry per conversation instead of one per message, so the
    UI can show 'a chat' instead of a flat, interleaved list of rows."""
    sessions = []
    current = None
    prev_dt = None

    for r in rows:
        dt = datetime.fromisoformat(r['created_at'])
        gap_exceeded = prev_dt is not None and (dt - prev_dt).total_seconds() > SESSION_GAP_MINUTES * 60

        if current is None or gap_exceeded:
            current = {
                'session_id':   r['id'],
                'started_at':   r['created_at'],
                'ended_at':     r['created_at'],
                'message_count': 0,
                'preview':      r['user_message'],
                'intents':      [],
                'messages':     []
            }
            sessions.append(current)

        current['ended_at'] = r['created_at']
        current['message_count'] += 1
        if r.get('intent'):
            current['intents'].append(r['intent'])
        current['messages'].append(r)
        prev_dt = dt

    for s in sessions:
        s['dominant_intent'] = max(set(s['intents']), key=s['intents'].count) if s['intents'] else None
        del s['intents']

    return sessions


def init_activity_tables():
    conn = get_pg_conn()
    try:
        c = conn.cursor()
        c.execute("""
            CREATE TABLE IF NOT EXISTS customer_login_log(
                id SERIAL PRIMARY KEY,
                account_number VARCHAR(30) REFERENCES dashboard_users(account_number),
                ip_address VARCHAR(64),
                user_agent TEXT,
                success BOOLEAN,
                created_at VARCHAR(64)
            )
        """)
        conn.commit()
    finally:
        release_pg_conn(conn)


def _require_admin():
    if 'admin_id' not in session:
        return jsonify({'success': False, 'message': 'Not authenticated'}), 401
    if session.get('admin_role') != 'admin':
        return jsonify({'success': False, 'message': 'Admin access required'}), 403
    return None


@activity_bp.route('/search-users', methods=['GET'])
def search_users():
    guard = _require_admin()
    if guard:
        return guard

    q = request.args.get('q', '').strip()
    if not q:
        return jsonify({'success': True, 'results': []})

    conn = get_pg_conn()
    try:
        c = conn.cursor()
        c.execute("""
            SELECT account_number, name, email FROM dashboard_users
            WHERE name ILIKE %s OR email ILIKE %s OR account_number ILIKE %s
            LIMIT 10
        """, (f'%{q}%', f'%{q}%', f'%{q}%'))
        rows = [dict(r) for r in c.fetchall()]
    finally:
        release_pg_conn(conn)

    return jsonify({'success': True, 'results': rows})


@activity_bp.route('/<account_number>/chat', methods=['GET'])
def chat_history_for_user(account_number):
    guard = _require_admin()
    if guard:
        return guard

    intent_filter = request.args.get('intent_filter', '').strip()
    date_from = request.args.get('date_from', '').strip()
    date_to = request.args.get('date_to', '').strip()
    page = request.args.get('page', 1, type=int)

    where = ["account_number = %s"]
    params = [account_number]
    if intent_filter:
        where.append("intent = %s"); params.append(intent_filter)
    if date_from:
        where.append("created_at >= %s"); params.append(date_from)
    if date_to:
        where.append("created_at <= %s"); params.append(date_to + 'T23:59:59')
    where_sql = ' AND '.join(where)

    conn = get_pg_conn()
    try:
        c = conn.cursor()
        # Session grouping needs full chronological context to find the
        # gaps correctly, so this pulls every matching row (ASC) and groups
        # in Python, then paginates over sessions rather than over rows.
        c.execute(f"""
            SELECT id, user_message, ai_response, intent,
                   COALESCE(sender, 'ai') AS sender, engine, created_at
            FROM chat_history
            WHERE {where_sql}
            ORDER BY created_at ASC
        """, params)
        rows = [dict(r) for r in c.fetchall()]
    finally:
        release_pg_conn(conn)

    sessions = _group_into_sessions(rows)
    sessions.reverse()  # most recent conversation first

    total = len(sessions)
    start = (page - 1) * PAGE_SIZE
    paged = sessions[start:start + PAGE_SIZE]

    return jsonify({
        'success': True,
        'sessions': paged,
        'total': total,
        'page': page,
        'pages': max(1, math.ceil(total / PAGE_SIZE))
    })


@activity_bp.route('/<account_number>/transactions', methods=['GET'])
def transactions_for_user(account_number):
    guard = _require_admin()
    if guard:
        return guard

    type_filter = request.args.get('type_filter', '').strip()
    date_from = request.args.get('date_from', '').strip()
    date_to = request.args.get('date_to', '').strip()
    page = request.args.get('page', 1, type=int)

    where = ["account_number = %s"]
    params = [account_number]
    if type_filter:
        where.append("transaction_type = %s"); params.append(type_filter)
    if date_from:
        where.append("created_at >= %s"); params.append(date_from)
    if date_to:
        where.append("created_at <= %s"); params.append(date_to + 'T23:59:59')
    where_sql = ' AND '.join(where)

    conn = get_pg_conn()
    try:
        c = conn.cursor()
        c.execute(f"SELECT COUNT(*) AS n FROM dashboard_transactions WHERE {where_sql}", params)
        total = c.fetchone()['n']

        c.execute(f"""
            SELECT id, transaction_type, description, amount, status,
                   created_at, COALESCE(anomaly_flagged, false) AS anomaly_flagged
            FROM dashboard_transactions
            WHERE {where_sql}
            ORDER BY created_at DESC
            LIMIT %s OFFSET %s
        """, params + [PAGE_SIZE, (page - 1) * PAGE_SIZE])
        rows = [dict(r) for r in c.fetchall()]
        for r in rows:
            r['amount'] = float(r['amount']) if r['amount'] is not None else 0.0
    finally:
        release_pg_conn(conn)

    return jsonify({
        'success': True,
        'transactions': rows,
        'total': total,
        'page': page,
        'pages': max(1, math.ceil(total / PAGE_SIZE))
    })


@activity_bp.route('/<account_number>/logins', methods=['GET'])
def logins_for_user(account_number):
    guard = _require_admin()
    if guard:
        return guard

    conn = get_pg_conn()
    try:
        c = conn.cursor()
        c.execute("""
            SELECT ip_address, user_agent, success, created_at
            FROM customer_login_log
            WHERE account_number = %s
            ORDER BY created_at DESC
            LIMIT 50
        """, (account_number,))
        rows = [dict(r) for r in c.fetchall()]
    finally:
        release_pg_conn(conn)

    return jsonify(rows)


@activity_bp.route('/<account_number>/receipt/<int:txn_id>', methods=['GET'])
def receipt_for_user_txn(account_number, txn_id):
    guard = _require_admin()
    if guard:
        return guard

    conn = get_pg_conn()
    try:
        c = conn.cursor()
        c.execute("""
            SELECT id, account_number, transaction_type, description, amount,
                   recipient, biller, bill_id, status, created_at
            FROM dashboard_transactions
            WHERE id = %s AND account_number = %s
        """, (txn_id, account_number))
        row = c.fetchone()
    finally:
        release_pg_conn(conn)

    if not row:
        return jsonify({'success': False, 'message': 'Transaction not found'}), 404

    row = dict(row)
    row['amount'] = float(row['amount']) if row['amount'] is not None else 0.0
    date_obj = datetime.fromisoformat(row['created_at'])
    receipt = {
        'transaction_id': row['id'],
        'account_number': row['account_number'],
        'transaction_type': row['transaction_type'],
        'description': row['description'],
        'amount': row['amount'],
        'recipient': row['recipient'],
        'biller': row['biller'],
        'bill_id': row['bill_id'],
        'status': row['status'],
        'date': date_obj.strftime('%b %d, %Y'),
        'time': date_obj.strftime('%I:%M %p'),
        'created_at': row['created_at']
    }
    return jsonify({'success': True, 'receipt': receipt})