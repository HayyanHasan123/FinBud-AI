"""
admin_routes/fraud.py — Fraud Alert List (/admin/fraud), admin only.

Matches FraudAlertList.jsx exactly:
  GET   /api/admin/fraud/alerts
  GET   /api/admin/fraud/alerts/<id>
  PATCH /api/admin/fraud/alerts/<id>/status
  POST  /api/admin/fraud/alerts/<id>/freeze-account

fraud_alerts (created in app.py's init_user_tables()) only has
(id, account_number, message, created_at) — this file owns extending it
with the columns doc 20 originally specified, since nobody else has.
Call init_fraud_tables() once from app.py's startup, same place
init_admin_tables()/init_goals_tables() etc. get called.
"""

from flask import Blueprint, request, jsonify, session
from datetime import datetime, timedelta

from features import get_pg_conn, release_pg_conn

fraud_bp = Blueprint('fraud', __name__, url_prefix='/api/admin/fraud')

ANOMALY_TYPES = ['emergency_lock', 'new_biller', 'amount_spike', 'duplicate_bill',
                  'large_transfer', 'rapid_fire', 'odd_hours', 'admin_freeze']
STATUS_VALUES = ['unreviewed', 'under_review', 'dismissed', 'escalated']


def init_fraud_tables():
    # NOTE: admin_tables.py's init_admin_tables() already runs these exact
    # ALTER TABLE fraud_alerts statements (with REFERENCES constraints this
    # version didn't have) and runs first in app.py's startup sequence, so
    # this function is now a deliberate no-op — kept only so existing calls
    # to it don't break. Nothing left to do here.
    pass


def _require_admin():
    if 'admin_id' not in session:
        return jsonify({'success': False, 'message': 'Not authenticated'}), 401
    if session.get('admin_role') != 'admin':
        return jsonify({'success': False, 'message': 'Admin access required'}), 403
    return None


@fraud_bp.route('/alerts', methods=['GET'])
def list_alerts():
    guard = _require_admin()
    if guard:
        return guard

    anomaly_type = request.args.get('anomaly_type', '').strip()
    status       = request.args.get('status', '').strip()
    date_from    = request.args.get('date_from', '').strip()
    date_to      = request.args.get('date_to', '').strip()
    search       = request.args.get('search', '').strip()

    where = []
    params = []
    if anomaly_type:
        where.append("f.anomaly_type = %s"); params.append(anomaly_type)
    if status:
        where.append("f.status = %s"); params.append(status)
    if date_from:
        where.append("f.created_at >= %s"); params.append(date_from)
    if date_to:
        where.append("f.created_at <= %s"); params.append(date_to + 'T23:59:59')
    if search:
        where.append("(u.name ILIKE %s OR f.account_number ILIKE %s)")
        params.extend([f'%{search}%', f'%{search}%'])

    where_sql = ('WHERE ' + ' AND '.join(where)) if where else ''

    conn = get_pg_conn()
    try:
        c = conn.cursor()
        c.execute(f"""
            SELECT f.id, f.account_number, u.name, f.anomaly_type, f.message,
                   f.status, f.created_at, f.transaction_id,
                   a.name AS reviewed_by_name
            FROM fraud_alerts f
            LEFT JOIN dashboard_users u ON u.account_number = f.account_number
            LEFT JOIN admin_users a ON a.id = f.reviewed_by
            {where_sql}
            ORDER BY f.created_at DESC
        """, params)
        rows = c.fetchall()
    finally:
        release_pg_conn(conn)

    return jsonify([dict(r) for r in rows])


@fraud_bp.route('/alerts/<int:alert_id>', methods=['GET'])
def alert_detail(alert_id):
    guard = _require_admin()
    if guard:
        return guard

    conn = get_pg_conn()
    try:
        c = conn.cursor()
        c.execute("""
            SELECT f.*, a.name AS reviewed_by_name
            FROM fraud_alerts f
            LEFT JOIN admin_users a ON a.id = f.reviewed_by
            WHERE f.id = %s
        """, (alert_id,))
        alert = c.fetchone()
        if not alert:
            return jsonify({'success': False, 'message': 'Alert not found'}), 404

        c.execute("""
            SELECT account_number, name, balance, account_status
            FROM dashboard_users WHERE account_number = %s
        """, (alert['account_number'],))
        user = c.fetchone()
        if user:
            user = dict(user)
            user['balance'] = float(user['balance']) if user['balance'] is not None else 0.0

        c.execute("""
            SELECT id, transaction_type AS type, description, amount, created_at AS date
            FROM dashboard_transactions
            WHERE account_number = %s
            ORDER BY created_at DESC LIMIT 10
        """, (alert['account_number'],))
        txns = [dict(r) for r in c.fetchall()]
        for t in txns:
            t['amount'] = float(t['amount']) if t['amount'] is not None else 0.0
    finally:
        release_pg_conn(conn)

    return jsonify({
        'success': True,
        'alert': dict(alert),
        'user': user,
        'recent_transactions': txns
    })


@fraud_bp.route('/alerts/<int:alert_id>/status', methods=['PATCH'])
def update_alert_status(alert_id):
    guard = _require_admin()
    if guard:
        return guard

    data = request.get_json(silent=True) or {}
    new_status = data.get('status', '').strip()
    note = data.get('resolution_note', '')

    if new_status not in STATUS_VALUES:
        return jsonify({'success': False, 'message': f'status must be one of {STATUS_VALUES}'}), 400

    conn = get_pg_conn()
    try:
        c = conn.cursor()
        c.execute("""
            UPDATE fraud_alerts
            SET status = %s, resolution_note = %s, reviewed_by = %s
            WHERE id = %s
        """, (new_status, note, session['admin_id'], alert_id))
        conn.commit()
    finally:
        release_pg_conn(conn)

    return jsonify({'success': True})


@fraud_bp.route('/alerts/<int:alert_id>/freeze-account', methods=['POST'])
def freeze_account(alert_id):
    guard = _require_admin()
    if guard:
        return guard

    data = request.get_json(silent=True) or {}
    reason = data.get('reason', '').strip()
    if not reason:
        return jsonify({'success': False, 'message': 'reason is required'}), 400

    conn = get_pg_conn()
    try:
        c = conn.cursor()
        c.execute("SELECT account_number, name FROM fraud_alerts JOIN dashboard_users "
                   "ON dashboard_users.account_number = fraud_alerts.account_number "
                   "WHERE fraud_alerts.id = %s", (alert_id,))
        row = c.fetchone()
        if not row:
            return jsonify({'success': False, 'message': 'Alert not found'}), 404
        account_number = row['account_number']

        c.execute("UPDATE dashboard_users SET account_status = 'frozen' WHERE account_number = %s", (account_number,))
        c.execute("UPDATE cards SET status = 'locked' WHERE account_number = %s", (account_number,))
        c.execute("""
            INSERT INTO fraud_alerts(account_number, message, created_at, anomaly_type, status, reviewed_by)
            VALUES (%s, %s, %s, 'admin_freeze', 'escalated', %s)
        """, (account_number, reason, datetime.utcnow().isoformat(), session['admin_id']))
        conn.commit()
    finally:
        release_pg_conn(conn)

    return jsonify({'success': True, 'account_number': account_number})