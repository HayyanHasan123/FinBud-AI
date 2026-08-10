"""
admin_routes/rewards.py — Rewards & Points Management (/admin/rewards), admin only.

Matches RewardsManagement.jsx exactly:
  GET /api/admin/rewards/summary
  GET /api/admin/rewards/redemptions
  GET /api/admin/rewards/user/<account_number>

redemptions has no tier column — tier is derived by matching points_used
against the existing REDEMPTION_TIERS dict from features.py (500/1000/750),
same source of truth the customer-facing redemption flow already uses.

points_issued (for the weekly trend + earned-all-time figures) isn't
logged as a separate event anywhere — it's derived from the same
"5 points per PKR 1000 spent" rule already used in app.py's transaction
routes, applied to transfer/bill transactions.
"""

from flask import Blueprint, request, jsonify, session
from datetime import datetime, timedelta
import math

from features import get_pg_conn, release_pg_conn, REDEMPTION_TIERS

rewards_bp = Blueprint('rewards', __name__, url_prefix='/api/admin/rewards')

PAGE_SIZE = 20

TIER_LABELS = {
    'cash_voucher': 'Cash Voucher',
    'product_purchase': 'Product Purchase',
    'investment_pocket': 'Investment Pocket',
}


def _tier_for_points(points_used):
    for key, cfg in REDEMPTION_TIERS.items():
        if cfg['points_cost'] == points_used:
            return key
    return 'unknown'


def _require_admin():
    if 'admin_id' not in session:
        return jsonify({'success': False, 'message': 'Not authenticated'}), 401
    if session.get('admin_role') != 'admin':
        return jsonify({'success': False, 'message': 'Admin access required'}), 403
    return None


@rewards_bp.route('/summary', methods=['GET'])
def summary():
    guard = _require_admin()
    if guard:
        return guard

    now = datetime.utcnow()
    month_start = datetime(now.year, now.month, 1).isoformat()

    conn = get_pg_conn()
    try:
        c = conn.cursor()

        c.execute("SELECT COALESCE(SUM(points), 0) AS n FROM dashboard_users")
        total_points_held = int(c.fetchone()['n'])

        c.execute("SELECT COALESCE(SUM(points_used), 0) AS n FROM redemptions WHERE created_at >= %s", (month_start,))
        total_redeemed_this_month = int(c.fetchone()['n'])

        c.execute("SELECT COALESCE(SUM(reward_value), 0) AS n FROM redemptions WHERE created_at >= %s", (month_start,))
        total_cash_paid_this_month = float(c.fetchone()['n'])

        c.execute("SELECT points_used, COUNT(*) AS cnt FROM redemptions GROUP BY points_used ORDER BY cnt DESC LIMIT 1")
        top_row = c.fetchone()
        most_popular_tier = _tier_for_points(top_row['points_used']) if top_row else None

        weekly_trend = []
        for i in range(7, -1, -1):
            week_end = now - timedelta(weeks=i)
            week_start = week_end - timedelta(days=7)
            ws_iso, we_iso = week_start.isoformat(), week_end.isoformat()

            c.execute("""
                SELECT COALESCE(SUM(FLOOR(ABS(amount)/1000) * 5), 0) AS n
                FROM dashboard_transactions
                WHERE transaction_type IN ('transfer', 'bill')
                  AND created_at >= %s AND created_at < %s
            """, (ws_iso, we_iso))
            issued = int(c.fetchone()['n'])

            c.execute("""
                SELECT COALESCE(SUM(points_used), 0) AS n FROM redemptions
                WHERE created_at >= %s AND created_at < %s
            """, (ws_iso, we_iso))
            redeemed = int(c.fetchone()['n'])

            weekly_trend.append({
                'week': week_start.strftime('%b %d'),
                'points_issued': issued,
                'points_redeemed': redeemed
            })
    finally:
        release_pg_conn(conn)

    return jsonify({
        'success': True,
        'total_points_held': total_points_held,
        'total_redeemed_this_month': total_redeemed_this_month,
        'total_cash_paid_this_month': total_cash_paid_this_month,
        'most_popular_tier': most_popular_tier,
        'weekly_trend': weekly_trend
    })


@rewards_bp.route('/redemptions', methods=['GET'])
def redemptions_list():
    guard = _require_admin()
    if guard:
        return guard

    tier_filter = request.args.get('tier_filter', '').strip()
    date_from = request.args.get('date_from', '').strip()
    date_to = request.args.get('date_to', '').strip()
    search = request.args.get('search', '').strip()
    page = request.args.get('page', 1, type=int)

    where = []
    params = []
    if date_from:
        where.append("r.created_at >= %s"); params.append(date_from)
    if date_to:
        where.append("r.created_at <= %s"); params.append(date_to + 'T23:59:59')
    if search:
        where.append("(u.name ILIKE %s OR r.account_number ILIKE %s)")
        params.extend([f'%{search}%', f'%{search}%'])
    if tier_filter and tier_filter in REDEMPTION_TIERS:
        where.append("r.points_used = %s"); params.append(REDEMPTION_TIERS[tier_filter]['points_cost'])
    where_sql = ('WHERE ' + ' AND '.join(where)) if where else ''

    conn = get_pg_conn()
    try:
        c = conn.cursor()
        c.execute(f"""
            SELECT COUNT(*) AS n FROM redemptions r
            LEFT JOIN dashboard_users u ON u.account_number = r.account_number
            {where_sql}
        """, params)
        total = c.fetchone()['n']

        c.execute(f"""
            SELECT r.id, r.account_number, u.name, r.points_used, r.reward_value, r.created_at
            FROM redemptions r
            LEFT JOIN dashboard_users u ON u.account_number = r.account_number
            {where_sql}
            ORDER BY r.created_at DESC
            LIMIT %s OFFSET %s
        """, params + [PAGE_SIZE, (page - 1) * PAGE_SIZE])
        rows = [dict(r) for r in c.fetchall()]
        for r in rows:
            r['reward_value'] = float(r['reward_value']) if r['reward_value'] is not None else 0.0
            tier_key = _tier_for_points(r['points_used'])
            r['tier_label'] = TIER_LABELS.get(tier_key, tier_key)
    finally:
        release_pg_conn(conn)

    return jsonify({
        'success': True,
        'redemptions': rows,
        'total': total,
        'page': page,
        'pages': max(1, math.ceil(total / PAGE_SIZE))
    })


@rewards_bp.route('/user/<account_number>', methods=['GET'])
def user_rewards(account_number):
    guard = _require_admin()
    if guard:
        return guard

    conn = get_pg_conn()
    try:
        c = conn.cursor()
        c.execute("SELECT points FROM dashboard_users WHERE account_number = %s", (account_number,))
        user_row = c.fetchone()
        current_points = int(user_row['points']) if user_row and user_row['points'] is not None else 0

        c.execute("""
            SELECT COALESCE(SUM(FLOOR(ABS(amount)/1000) * 5), 0) AS n
            FROM dashboard_transactions
            WHERE account_number = %s AND transaction_type IN ('transfer', 'bill')
        """, (account_number,))
        total_earned_all_time = int(c.fetchone()['n'])

        c.execute("SELECT COALESCE(SUM(points_used), 0) AS n FROM redemptions WHERE account_number = %s", (account_number,))
        total_redeemed_all_time = int(c.fetchone()['n'])

        c.execute("""
            SELECT points_used, reward_value, created_at FROM redemptions
            WHERE account_number = %s ORDER BY created_at DESC
        """, (account_number,))
        history = [dict(r) for r in c.fetchall()]
        for h in history:
            h['reward_value'] = float(h['reward_value']) if h['reward_value'] is not None else 0.0
    finally:
        release_pg_conn(conn)

    return jsonify({
        'success': True,
        'current_points': current_points,
        'total_earned_all_time': total_earned_all_time,
        'total_redeemed_all_time': total_redeemed_all_time,
        'redemption_history': history
    })