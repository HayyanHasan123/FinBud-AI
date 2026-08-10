# admin_routes/overview.py
# ─────────────────────────────────────────────────────────────────────────────
# Blueprint  : overview_bp  →  registered at /api/admin/overview
# Access     : admin only (require_admin_role)
#
# Register in app.py:
#   from admin_routes.overview import overview_bp
#   app.register_blueprint(overview_bp)
# ─────────────────────────────────────────────────────────────────────────────

from datetime import datetime, timedelta

from flask import Blueprint, jsonify

from features import get_pg_conn, release_pg_conn
from admin_routes.auth import require_admin_role

overview_bp = Blueprint('overview', __name__, url_prefix='/api/admin/overview')


# ── GET /api/admin/overview/stats ────────────────────────────────────────────
@overview_bp.route('/stats', methods=['GET'])
@require_admin_role
def stats():
    conn = get_pg_conn()
    c    = conn.cursor()

    c.execute("SELECT COUNT(*) AS n FROM dashboard_users")
    total_users = c.fetchone()['n']

    c.execute("""
        SELECT COUNT(*) AS n FROM dashboard_users
        WHERE created_at::date = CURRENT_DATE
    """)
    new_users_today = c.fetchone()['n']

    c.execute("""
        SELECT COUNT(*) AS cnt, COALESCE(SUM(ABS(amount)), 0) AS vol
        FROM   dashboard_transactions
        WHERE  created_at::date = CURRENT_DATE
    """)
    row = c.fetchone()
    transactions_today_count  = row['cnt']
    transactions_today_volume = float(row['vol'])

    c.execute("SELECT COUNT(*) AS n FROM fraud_alerts WHERE status='unreviewed'")
    open_fraud_alerts = c.fetchone()['n']

    c.execute("SELECT COUNT(*) AS n FROM kyc_submissions WHERE status='pending'")
    pending_kyc = c.fetchone()['n']

    release_pg_conn(conn)
    return jsonify({
        'success':                    True,
        'total_users':                total_users,
        'new_users_today':            new_users_today,
        'transactions_today_count':   transactions_today_count,
        'transactions_today_volume':  transactions_today_volume,
        'open_fraud_alerts':          open_fraud_alerts,
        'pending_kyc':                pending_kyc
    })


# ── GET /api/admin/overview/transaction-volume ───────────────────────────────
@overview_bp.route('/transaction-volume', methods=['GET'])
@require_admin_role
def transaction_volume():
    conn = get_pg_conn()
    c    = conn.cursor()

    days = []
    today = datetime.utcnow().date()
    for i in range(6, -1, -1):
        day = today - timedelta(days=i)
        c.execute("""
            SELECT COALESCE(SUM(ABS(amount)), 0) AS vol
            FROM   dashboard_transactions
            WHERE  created_at::date = %s
        """, (day,))
        vol = float(c.fetchone()['vol'])
        days.append({'date': day.strftime('%b %d'), 'volume': vol})

    release_pg_conn(conn)
    return jsonify({'success': True, 'days': days})


# ── GET /api/admin/overview/intent-distribution ──────────────────────────────
@overview_bp.route('/intent-distribution', methods=['GET'])
@require_admin_role
def intent_distribution():
    conn = get_pg_conn()
    c    = conn.cursor()

    since = (datetime.utcnow() - timedelta(hours=24)).isoformat()
    c.execute("""
        SELECT intent, COUNT(*) AS cnt
        FROM   chat_history
        WHERE  created_at >= %s AND intent IS NOT NULL
        GROUP  BY intent
        ORDER  BY cnt DESC
    """, (since,))
    data = [{'intent': r['intent'], 'count': r['cnt']} for r in c.fetchall()]

    release_pg_conn(conn)
    return jsonify({'success': True, 'data': data, 'insufficient_data': False})


# ── GET /api/admin/overview/llm-fallback-rate ─────────────────────────────────
@overview_bp.route('/llm-fallback-rate', methods=['GET'])
@require_admin_role
def llm_fallback_rate():
    # chat_history.engine isn't populated yet (see admin_tables.py note) —
    # always return the "coming online soon" shape until that lands.
    return jsonify({'success': True, 'data': [], 'insufficient_data': True})


# ── GET /api/admin/overview/recent-feed ──────────────────────────────────────
@overview_bp.route('/recent-feed', methods=['GET'])
@require_admin_role
def recent_feed():
    conn = get_pg_conn()
    c    = conn.cursor()

    c.execute("""
        SELECT
            fa.id, fa.account_number, COALESCE(du.name, 'Unknown') AS name,
            fa.anomaly_type, fa.created_at
        FROM   fraud_alerts fa
        LEFT   JOIN dashboard_users du ON du.account_number = fa.account_number
        ORDER  BY fa.created_at DESC
        LIMIT  5
    """)
    fraud_alerts = [dict(r) for r in c.fetchall()]

    c.execute("""
        SELECT id, account_number AS account, status, created_at
        FROM   handoff_queue
        ORDER  BY created_at DESC
        LIMIT  5
    """)
    tickets = [dict(r) for r in c.fetchall()]

    c.execute("""
        SELECT
            k.id, k.account_number, COALESCE(du.name, 'Unknown') AS name,
            k.submitted_at
        FROM   kyc_submissions k
        LEFT   JOIN dashboard_users du ON du.account_number = k.account_number
        ORDER  BY k.submitted_at DESC
        LIMIT  5
    """)
    kyc = [dict(r) for r in c.fetchall()]

    release_pg_conn(conn)
    return jsonify({
        'success':      True,
        'fraud_alerts': fraud_alerts,
        'tickets':      tickets,
        'kyc':          kyc
    })
