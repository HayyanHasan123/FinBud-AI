# admin_routes/transactions.py
# ─────────────────────────────────────────────────────────────────────────────
# Blueprint  : transactions_bp  →  registered at /api/admin/transactions
# Access     : admin only
#
# ASSUMPTIONS: fraud_alerts.transaction_id / .anomaly_type are columns added
# by admin_tables.py (same assumption fraud.py already relies on).
#
# Register in app.py:
#   from admin_routes.transactions import transactions_bp
#   app.register_blueprint(transactions_bp)
# ─────────────────────────────────────────────────────────────────────────────

import csv
import io
from flask import Blueprint, request, jsonify, Response
from features import get_pg_conn, release_pg_conn
from admin_routes.auth import require_admin_role as admin_only

transactions_bp = Blueprint('transactions', __name__, url_prefix='/api/admin/transactions')


def _build_filters(args):
    """Shared WHERE-clause builder for the list route and the CSV export."""
    conditions, params = [], []

    type_filter    = args.get('type_filter', '').strip()
    amount_min     = args.get('amount_min', '').strip()
    amount_max     = args.get('amount_max', '').strip()
    anomaly_only   = args.get('anomaly_only', '').strip().lower() in ('1', 'true', 'yes')
    date_from      = args.get('date_from', '').strip()
    date_to        = args.get('date_to', '').strip()
    account_number = args.get('account_number', '').strip()

    if type_filter:
        conditions.append("dt.transaction_type = %s"); params.append(type_filter)
    if amount_min:
        conditions.append("dt.amount >= %s"); params.append(amount_min)
    if amount_max:
        conditions.append("dt.amount <= %s"); params.append(amount_max)
    if anomaly_only:
        conditions.append("fa.id IS NOT NULL")
    if date_from:
        conditions.append("dt.created_at >= %s"); params.append(date_from)
    if date_to:
        conditions.append("dt.created_at <= %s"); params.append(date_to)
    if account_number:
        conditions.append("dt.account_number = %s"); params.append(account_number)

    where = f"WHERE {' AND '.join(conditions)}" if conditions else ""
    return where, params


_BASE_JOIN = """
    FROM   dashboard_transactions dt
    LEFT   JOIN dashboard_users du ON du.account_number = dt.account_number
    LEFT   JOIN fraud_alerts    fa ON fa.transaction_id  = dt.id
"""


# ── GET /api/admin/transactions ──────────────────────────────────────────────
@transactions_bp.route('', methods=['GET'])
@admin_only
def list_transactions():
    page     = max(1, int(request.args.get('page', 1)))
    per_page = 20

    where, params = _build_filters(request.args)

    conn = get_pg_conn()
    c    = conn.cursor()

    c.execute(f"SELECT COUNT(*) AS n {_BASE_JOIN} {where}", params)
    total = c.fetchone()['n']

    c.execute(f"""
        SELECT
            COUNT(*)                                   AS total_count,
            COALESCE(SUM(dt.amount), 0)                 AS total_volume,
            COUNT(*) FILTER (WHERE fa.id IS NOT NULL)    AS flagged_count
        {_BASE_JOIN} {where}
    """, params)
    srow = c.fetchone()
    summary = {
        'total_count':   srow['total_count'],
        'total_volume':  float(srow['total_volume']),
        'flagged_count': srow['flagged_count']
    }

    offset = (page - 1) * per_page
    c.execute(f"""
        SELECT
            dt.id,
            dt.account_number,
            COALESCE(du.name, 'Unknown') AS name,
            dt.transaction_type,
            dt.description,
            dt.amount,
            dt.status,
            CASE WHEN fa.id IS NOT NULL THEN true ELSE false END AS anomaly_flagged,
            fa.anomaly_type,
            dt.created_at
        {_BASE_JOIN} {where}
        ORDER  BY dt.created_at DESC
        LIMIT  %s OFFSET %s
    """, params + [per_page, offset])

    transactions = []
    for r in c.fetchall():
        t = dict(r)
        t['amount'] = float(t['amount'])
        transactions.append(t)

    release_pg_conn(conn)
    return jsonify({
        'success':      True,
        'transactions': transactions,
        'total':        total,
        'page':         page,
        'pages':        max(1, -(-total // per_page)),
        'summary':      summary
    })


# ── GET /api/admin/transactions/<id> ─────────────────────────────────────────
@transactions_bp.route('/<int:txn_id>', methods=['GET'])
@admin_only
def get_transaction(txn_id):
    conn = get_pg_conn()
    c    = conn.cursor()

    c.execute(f"""
        SELECT
            dt.id, dt.account_number, COALESCE(du.name, 'Unknown') AS name,
            dt.transaction_type, dt.description, dt.amount, dt.status,
            dt.recipient, dt.biller, dt.created_at,
            CASE WHEN fa.id IS NOT NULL THEN true ELSE false END AS anomaly_flagged,
            fa.anomaly_type
        {_BASE_JOIN}
        WHERE  dt.id = %s
    """, (txn_id,))
    row = c.fetchone()
    release_pg_conn(conn)

    if not row:
        return jsonify({'success': False, 'message': 'Transaction not found'}), 404

    result = {
        'success':          True,
        'transaction_id':   row['id'],
        'account_number':   row['account_number'],
        'user':             {'name': row['name']},
        'transaction_type': row['transaction_type'],
        'description':      row['description'],
        'amount':           float(row['amount']),
        'status':           row['status'],
        'created_at':       row['created_at'],
        'anomaly_flagged':  row['anomaly_flagged']
    }
    if row['recipient']:
        result['recipient'] = row['recipient']
    if row['biller']:
        result['biller'] = row['biller']
    if row['anomaly_flagged']:
        result['anomaly_type'] = row['anomaly_type']

    return jsonify(result)


# ── GET /api/admin/transactions/export ───────────────────────────────────────
@transactions_bp.route('/export', methods=['GET'])
@admin_only
def export_transactions():
    where, params = _build_filters(request.args)

    conn = get_pg_conn()
    c    = conn.cursor()
    c.execute(f"""
        SELECT
            dt.id, dt.account_number, COALESCE(du.name, 'Unknown') AS name,
            dt.transaction_type, dt.description, dt.amount, dt.status,
            fa.anomaly_type, dt.created_at
        {_BASE_JOIN} {where}
        ORDER  BY dt.created_at DESC
    """, params)
    rows = c.fetchall()
    release_pg_conn(conn)

    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(['ID', 'Account', 'Name', 'Type', 'Description', 'Amount', 'Status', 'Anomaly', 'Date'])
    for r in rows:
        writer.writerow([
            r['id'], r['account_number'], r['name'], r['transaction_type'],
            r['description'], float(r['amount']), r['status'],
            r['anomaly_type'] or '', r['created_at']
        ])

    return Response(
        buf.getvalue(),
        mimetype='text/csv',
        headers={'Content-Disposition': 'attachment; filename=transactions.csv'}
    )