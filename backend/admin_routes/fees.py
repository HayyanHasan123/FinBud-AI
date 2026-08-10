# admin_routes/fees.py
# ─────────────────────────────────────────────────────────────────────────────
# Blueprint  : fees_bp  →  registered at /api/admin/fees
# Access     : admin only
#
# ⚠ transfer_fees is created by admin_tables.py and is not yet populated by
# any write path (that requires a change to /api/transaction/create which is
# out of scope for this file). Every route here is built correctly against
# the real table and will simply return honest zeros / empty lists until
# that write path exists — FeeReporting.jsx already handles the empty state,
# so no special-casing is added here.
#
# Register in app.py:
#   from admin_routes.fees import fees_bp
#   app.register_blueprint(fees_bp)
# ─────────────────────────────────────────────────────────────────────────────

import csv
import io
from flask import Blueprint, request, jsonify, Response
from datetime import datetime, timedelta
from features import get_pg_conn, release_pg_conn
from admin_routes.auth import require_admin_role as admin_only

fees_bp = Blueprint('fees', __name__, url_prefix='/api/admin/fees')


# ── GET /api/admin/fees/summary ──────────────────────────────────────────────
@fees_bp.route('/summary', methods=['GET'])
@admin_only
def summary():
    now          = datetime.utcnow()
    today_start  = now.strftime('%Y-%m-%d')
    month_start  = now.strftime('%Y-%m-01')
    thirty_days  = (now - timedelta(days=30)).isoformat()

    conn = get_pg_conn()
    c    = conn.cursor()

    c.execute(
        "SELECT COALESCE(SUM(fee_amount), 0) AS n FROM transfer_fees WHERE created_at >= %s",
        (today_start,)
    )
    fees_today = float(c.fetchone()['n'])

    c.execute(
        "SELECT COALESCE(SUM(fee_amount), 0) AS n FROM transfer_fees WHERE created_at >= %s",
        (month_start,)
    )
    fees_this_month = float(c.fetchone()['n'])

    c.execute("SELECT COALESCE(SUM(fee_amount), 0) AS n FROM transfer_fees")
    fees_all_time = float(c.fetchone()['n'])

    c.execute(
        "SELECT COALESCE(AVG(fee_amount), 0) AS n, COUNT(*) AS n2 FROM transfer_fees WHERE created_at >= %s",
        (month_start,)
    )
    avg_row = c.fetchone()
    avg_fee_per_transaction = float(avg_row['n'])
    transaction_count_this_month = avg_row['n2']

    c.execute("""
        SELECT DATE(created_at::timestamp) AS d, COALESCE(SUM(fee_amount), 0) AS total
        FROM   transfer_fees
        WHERE  created_at >= %s
        GROUP  BY d
        ORDER  BY d ASC
    """, (thirty_days,))
    daily_trend = [{'date': str(r['d']), 'fee_total': float(r['total'])} for r in c.fetchall()]

    release_pg_conn(conn)
    return jsonify({
        'success':                       True,
        'fees_today':                    fees_today,
        'fees_this_month':               fees_this_month,
        'fees_all_time':                 fees_all_time,
        'avg_fee_per_transaction':       avg_fee_per_transaction,
        'daily_trend':                   daily_trend,
        'transaction_count_this_month':  transaction_count_this_month
    })


# ── GET /api/admin/fees/ledger ───────────────────────────────────────────────
@fees_bp.route('/ledger', methods=['GET'])
@admin_only
def ledger():
    date_from = request.args.get('date_from', '').strip()
    date_to   = request.args.get('date_to', '').strip()
    page      = max(1, int(request.args.get('page', 1)))
    per_page  = 20

    conditions, params = [], []
    if date_from:
        conditions.append("tf.created_at >= %s"); params.append(date_from)
    if date_to:
        conditions.append("tf.created_at <= %s"); params.append(date_to)
    where = f"WHERE {' AND '.join(conditions)}" if conditions else ""

    conn = get_pg_conn()
    c    = conn.cursor()

    c.execute(f"""
        SELECT COUNT(*) AS n
        FROM   transfer_fees tf
        LEFT   JOIN dashboard_users du ON du.account_number = tf.account_number
        {where}
    """, params)
    total  = c.fetchone()['n']
    offset = (page - 1) * per_page

    c.execute(f"""
        SELECT
            tf.id, tf.transaction_id, tf.account_number,
            COALESCE(du.name, 'Unknown') AS name,
            tf.transfer_amount, tf.fee_amount, tf.fee_percentage, tf.created_at
        FROM   transfer_fees tf
        LEFT   JOIN dashboard_users du ON du.account_number = tf.account_number
        {where}
        ORDER  BY tf.created_at DESC
        LIMIT  %s OFFSET %s
    """, params + [per_page, offset])

    fees = []
    for r in c.fetchall():
        row = dict(r)
        row['transfer_amount'] = float(row['transfer_amount'])
        row['fee_amount']      = float(row['fee_amount'])
        row['fee_percentage']  = float(row['fee_percentage'])
        fees.append(row)

    release_pg_conn(conn)
    return jsonify({
        'success': True,
        'fees':    fees,
        'total':   total,
        'page':    page,
        'pages':   max(1, -(-total // per_page))
    })


# ── GET /api/admin/fees/export ───────────────────────────────────────────────
@fees_bp.route('/export', methods=['GET'])
@admin_only
def export_fees():
    date_from = request.args.get('date_from', '').strip()
    date_to   = request.args.get('date_to', '').strip()

    conditions, params = [], []
    if date_from:
        conditions.append("tf.created_at >= %s"); params.append(date_from)
    if date_to:
        conditions.append("tf.created_at <= %s"); params.append(date_to)
    where = f"WHERE {' AND '.join(conditions)}" if conditions else ""

    conn = get_pg_conn()
    c    = conn.cursor()
    c.execute(f"""
        SELECT
            tf.transaction_id, tf.account_number, COALESCE(du.name, 'Unknown') AS name,
            tf.transfer_amount, tf.fee_amount, tf.fee_percentage, tf.created_at
        FROM   transfer_fees tf
        LEFT   JOIN dashboard_users du ON du.account_number = tf.account_number
        {where}
        ORDER  BY tf.created_at DESC
    """, params)
    rows = c.fetchall()
    release_pg_conn(conn)

    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(['Transaction ID', 'Account', 'Name', 'Transfer Amount PKR', 'Fee Amount PKR', 'Fee %', 'Date'])
    for r in rows:
        writer.writerow([
            r['transaction_id'], r['account_number'], r['name'],
            float(r['transfer_amount']), float(r['fee_amount']), float(r['fee_percentage']),
            r['created_at']
        ])

    return Response(
        buf.getvalue(),
        mimetype='text/csv',
        headers={'Content-Disposition': 'attachment; filename=fees.csv'}
    )