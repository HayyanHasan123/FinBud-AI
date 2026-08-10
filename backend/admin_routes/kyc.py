"""
admin_routes/kyc.py — KYC / Identity Review Queue (/admin/kyc), admin only.

Matches KYCReviewQueue.jsx exactly:
  GET  /api/admin/kyc/queue
  POST /api/admin/kyc/<id>/approve
  POST /api/admin/kyc/<id>/flag

kyc_submissions was confirmed missing from the real database (checked the
actual features.py — no such table anywhere). init_kyc_tables() creates it
defensively here with IF NOT EXISTS, safe to call even if admin_tables.py
already created it elsewhere — whichever runs first wins, no conflict.
"""

from flask import Blueprint, request, jsonify, session
from datetime import datetime, timedelta

from features import get_pg_conn, release_pg_conn

kyc_bp = Blueprint('kyc', __name__, url_prefix='/api/admin/kyc')

FLAG_REASONS = ['face_mismatch', 'cnic_altered', 'duplicate_cnic', 'other']


def init_kyc_tables():
    # NOTE: admin_tables.py's init_admin_tables() already creates
    # kyc_submissions (with a REFERENCES admin_users(id) constraint this
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


@kyc_bp.route('/queue', methods=['GET'])
def queue():
    guard = _require_admin()
    if guard:
        return guard

    status_filter = request.args.get('status', '').strip()

    where = []
    params = []
    if status_filter:
        where.append("k.status = %s"); params.append(status_filter)
    where_sql = ('WHERE ' + ' AND '.join(where)) if where else ''

    now = datetime.utcnow()
    week_ago = (now - timedelta(days=7)).isoformat()

    conn = get_pg_conn()
    try:
        c = conn.cursor()

        c.execute(f"""
            SELECT k.id, k.account_number, u.name, k.cnic_number, k.selfie_url,
                   k.cnic_front_url, k.status, k.flag_reason, k.submitted_at,
                   a.name AS reviewed_by_name
            FROM kyc_submissions k
            LEFT JOIN dashboard_users u ON u.account_number = k.account_number
            LEFT JOIN admin_users a ON a.id = k.reviewed_by
            {where_sql}
            ORDER BY k.submitted_at ASC
        """, params)
        submissions = [dict(r) for r in c.fetchall()]

        count_where = f" {where_sql}" if where_sql else ""
        c.execute(f"SELECT COUNT(*) AS n FROM kyc_submissions k{count_where}", params)
        total = c.fetchone()['n']

        c.execute("SELECT COUNT(*) AS n FROM kyc_submissions WHERE status = 'pending'")
        pending_count = c.fetchone()['n']

        c.execute("SELECT COUNT(*) AS n FROM kyc_submissions WHERE status = 'approved' AND reviewed_at >= %s", (week_ago,))
        approved_this_week = c.fetchone()['n']

        c.execute("SELECT COUNT(*) AS n FROM kyc_submissions WHERE status = 'flagged' AND reviewed_at >= %s", (week_ago,))
        flagged_this_week = c.fetchone()['n']

        c.execute("""
            SELECT submitted_at, reviewed_at FROM kyc_submissions
            WHERE reviewed_at IS NOT NULL AND submitted_at IS NOT NULL
        """)
        durations = []
        for r in c.fetchall():
            try:
                sub = datetime.fromisoformat(r['submitted_at'])
                rev = datetime.fromisoformat(r['reviewed_at'])
                durations.append((rev - sub).total_seconds() / 3600.0)
            except Exception:
                continue
        avg_review_time_hours = round(sum(durations) / len(durations), 1) if durations else None
    finally:
        release_pg_conn(conn)

    return jsonify({
        'success': True,
        'submissions': submissions,
        'total': total,
        'pending_count': pending_count,
        'approved_this_week': approved_this_week,
        'flagged_this_week': flagged_this_week,
        'avg_review_time_hours': avg_review_time_hours
    })


@kyc_bp.route('/<int:submission_id>/approve', methods=['POST'])
def approve(submission_id):
    guard = _require_admin()
    if guard:
        return guard

    conn = get_pg_conn()
    try:
        c = conn.cursor()
        c.execute("""
            UPDATE kyc_submissions
            SET status = 'approved', reviewed_by = %s, reviewed_at = %s
            WHERE id = %s
        """, (session['admin_id'], datetime.utcnow().isoformat(), submission_id))
        conn.commit()
    finally:
        release_pg_conn(conn)

    return jsonify({'success': True})


@kyc_bp.route('/<int:submission_id>/flag', methods=['POST'])
def flag(submission_id):
    guard = _require_admin()
    if guard:
        return guard

    data = request.get_json(silent=True) or {}
    reason = data.get('reason', '').strip()
    if reason not in FLAG_REASONS:
        return jsonify({'success': False, 'message': f'reason must be one of {FLAG_REASONS}'}), 400

    conn = get_pg_conn()
    try:
        c = conn.cursor()
        c.execute("""
            UPDATE kyc_submissions
            SET status = 'flagged', flag_reason = %s, reviewed_by = %s, reviewed_at = %s
            WHERE id = %s
        """, (reason, session['admin_id'], datetime.utcnow().isoformat(), submission_id))
        conn.commit()
    finally:
        release_pg_conn(conn)

    return jsonify({'success': True})