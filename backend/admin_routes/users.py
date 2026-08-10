# admin_routes/users.py
# ─────────────────────────────────────────────────────────────────────────────
# Blueprint  : users_bp  →  registered at /api/admin/users
# Access     : admin AND banker — SAME route, response is masked in Python
#              for bankers before jsonify (never send the real fields and
#              hide them client-side).
#
# ASSUMPTIONS (columns owned by admin_tables.py, not this file):
#   dashboard_users.account_status  -- 'active' | 'frozen'
#                                       (already relied on by fraud.py's
#                                       freeze_account route)
#   kyc_status is derived per-account from the most recent kyc_submissions
#   row (kyc.py's table) rather than a column on dashboard_users, since
#   kyc_submissions is the single source of truth for KYC state elsewhere
#   in this API. Accounts with no submissions show kyc_status='not_submitted'.
#
# Register in app.py:
#   from admin_routes.users import users_bp
#   app.register_blueprint(users_bp)
# ─────────────────────────────────────────────────────────────────────────────

from flask import Blueprint, request, jsonify, session
from datetime import datetime
from features import get_pg_conn, release_pg_conn
from admin_routes.auth import require_admin_auth as admin_required, require_admin_role as admin_only

users_bp = Blueprint('users', __name__, url_prefix='/api/admin/users')


def _is_admin():
    return session.get('admin_role') == 'admin'


# ── GET /api/admin/users ─────────────────────────────────────────────────────
@users_bp.route('', methods=['GET'])
@admin_required
def list_users():
    search         = request.args.get('search', '').strip()
    kyc_status_f   = request.args.get('kyc_status', '').strip()
    account_status = request.args.get('account_status', '').strip()
    date_from      = request.args.get('date_from', '').strip()
    date_to        = request.args.get('date_to', '').strip()
    page           = max(1, int(request.args.get('page', 1)))
    per_page       = 20

    is_admin = _is_admin()

    conn = get_pg_conn()
    c    = conn.cursor()

    conditions, params = [], []

    if search:
        conditions.append("(du.name ILIKE %s OR du.account_number ILIKE %s OR du.email ILIKE %s)")
        params.extend([f'%{search}%', f'%{search}%', f'%{search}%'])
    if account_status:
        conditions.append("COALESCE(du.account_status, 'active') = %s")
        params.append(account_status)
    if date_from:
        conditions.append("du.created_at >= %s"); params.append(date_from)
    if date_to:
        conditions.append("du.created_at <= %s"); params.append(date_to)

    where = f"WHERE {' AND '.join(conditions)}" if conditions else ""

    # kyc_status is derived, so it's filtered in Python after the base query
    # rather than in SQL (keeps the "latest submission per account" logic
    # in one place instead of duplicating a correlated subquery twice).
    c.execute(f"""
        SELECT
            du.account_number,
            du.name,
            du.email,
            du.phone,
            du.balance,
            du.points,
            COALESCE(du.account_status, 'active') AS account_status,
            du.created_at,
            (SELECT COUNT(*) FROM cards ca WHERE ca.account_number = du.account_number) AS card_count
        FROM   dashboard_users du
        {where}
        ORDER  BY du.created_at DESC
    """, params)

    rows = [dict(r) for r in c.fetchall()]

    # Attach derived kyc_status (latest submission per account_number).
    accounts = [r['account_number'] for r in rows]
    kyc_by_account = {}
    if accounts:
        c.execute("""
            SELECT DISTINCT ON (account_number) account_number, status
            FROM   kyc_submissions
            WHERE  account_number = ANY(%s)
            ORDER  BY account_number, submitted_at DESC
        """, (accounts,))
        kyc_by_account = {r['account_number']: r['status'] for r in c.fetchall()}

    release_pg_conn(conn)

    filtered = []
    for r in rows:
        k = kyc_by_account.get(r['account_number'], 'not_submitted')
        if kyc_status_f and k != kyc_status_f:
            continue
        r['kyc_status'] = k
        r['balance']    = float(r['balance']) if r['balance'] is not None else 0.0
        if not is_admin:
            r['email']   = None
            r['phone']   = None
            r['balance'] = None
            r['points']  = None
        filtered.append(r)

    total  = len(filtered)
    pages  = max(1, -(-total // per_page))
    start  = (page - 1) * per_page
    paged  = filtered[start:start + per_page]

    return jsonify({
        'success': True,
        'users':   paged,
        'total':   total,
        'page':    page,
        'pages':   pages
    })


# ── GET /api/admin/users/<account_number> ────────────────────────────────────
@users_bp.route('/<account_number>', methods=['GET'])
@admin_required
def get_user(account_number):
    is_admin = _is_admin()

    conn = get_pg_conn()
    c    = conn.cursor()

    c.execute("""
        SELECT name, account_number, email, phone, balance, points,
               language, created_at, COALESCE(account_status, 'active') AS account_status
        FROM   dashboard_users
        WHERE  account_number = %s
    """, (account_number,))
    row = c.fetchone()
    if not row:
        release_pg_conn(conn)
        return jsonify({'success': False, 'message': 'User not found'}), 404

    user = dict(row)
    user['balance'] = float(user['balance']) if user['balance'] is not None else 0.0
    if not is_admin:
        user['email']    = None
        user['phone']    = None
        user['balance']  = None
        user['points']   = None
        user['language'] = None
        user['created_at'] = None

    c.execute("""
        SELECT card_number, status, nickname
        FROM   cards
        WHERE  account_number = %s
    """, (account_number,))
    cards = []
    for r in c.fetchall():
        num = r['card_number'] or ''
        masked = f"**** **** **** {num[-4:]}" if len(num) >= 4 else num
        cards.append({
            'card_number_masked': masked,
            'status':             r['status'],
            'nickname':           r['nickname']
        })

    c.execute("""
        SELECT status, submitted_at
        FROM   kyc_submissions
        WHERE  account_number = %s
        ORDER  BY submitted_at DESC
        LIMIT  1
    """, (account_number,))
    kyc_row = c.fetchone()
    kyc = {'status': kyc_row['status'], 'submitted_at': kyc_row['submitted_at']} if kyc_row \
        else {'status': 'not_submitted', 'submitted_at': None}

    c.execute("SELECT COUNT(*) AS n FROM fraud_alerts WHERE account_number = %s", (account_number,))
    fraud_alert_count = c.fetchone()['n']

    c.execute("SELECT COUNT(*) AS n FROM dashboard_transactions WHERE account_number = %s", (account_number,))
    total_transactions = c.fetchone()['n']

    release_pg_conn(conn)

    return jsonify({
        'success':             True,
        'user':                user,
        'cards':               cards,
        'kyc':                 kyc,
        'fraud_alert_count':   fraud_alert_count,
        'total_transactions':  total_transactions
    })


# ── PATCH /api/admin/users/<account_number>/status ───────────────────────────
@users_bp.route('/<account_number>/status', methods=['PATCH'])
@admin_only
def update_status(account_number):
    data       = request.json or {}
    new_status = data.get('status', '').strip()
    reason     = data.get('reason', '').strip()

    if new_status not in ('active', 'frozen'):
        return jsonify({'success': False, 'message': "status must be 'active' or 'frozen'"}), 400

    conn = get_pg_conn()
    c    = conn.cursor()

    c.execute("SELECT account_number FROM dashboard_users WHERE account_number = %s", (account_number,))
    if not c.fetchone():
        release_pg_conn(conn)
        return jsonify({'success': False, 'message': 'User not found'}), 404

    c.execute(
        "UPDATE dashboard_users SET account_status = %s WHERE account_number = %s",
        (new_status, account_number)
    )

    if new_status == 'frozen':
        c.execute(
            "UPDATE cards SET status = 'locked' WHERE account_number = %s",
            (account_number,)
        )
        c.execute("""
            INSERT INTO fraud_alerts(account_number, message, anomaly_type, status, created_at)
            VALUES (%s, %s, 'admin_freeze', 'unreviewed', %s)
        """, (account_number, reason or 'Account frozen by admin', datetime.utcnow().isoformat()))
    # Unfreezing intentionally does NOT auto-unlock cards — separate action.

    conn.commit()
    release_pg_conn(conn)
    return jsonify({'success': True, 'new_status': new_status})