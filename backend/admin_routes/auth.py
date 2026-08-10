# admin_routes/auth.py
# ─────────────────────────────────────────────────────────────────────────────
# Blueprint  : auth_bp  →  registered at /api/admin  (routes below are given
#              as full absolute paths and are unprefixed on the blueprint so
#              they land exactly where adminApi.js expects them)
# Connection : get_pg_conn / release_pg_conn from features.py (same pool)
#
# Also exports require_admin_auth — the same decorator shape as fraud.py's
# admin_required, so later files can import it from here instead of each
# redefining their own copy.
#
# Register in app.py:
#   from admin_routes.auth import auth_bp
#   app.register_blueprint(auth_bp)
# ─────────────────────────────────────────────────────────────────────────────

import os
from functools import wraps
from datetime import datetime

from flask import Blueprint, request, jsonify, session
from werkzeug.security import check_password_hash

from features import get_pg_conn, release_pg_conn

auth_bp = Blueprint('admin_auth', __name__, url_prefix='/api/admin')


# ── Auth guards ────────────────────────────────────────────────────────────────
def require_admin_auth(f):
    """Any logged-in admin session (admin or banker role). 401 if missing."""
    @wraps(f)
    def decorated(*args, **kwargs):
        if 'admin_id' not in session:
            return jsonify({'success': False, 'message': 'Admin authentication required'}), 401
        return f(*args, **kwargs)
    return decorated


def require_admin_role(f):
    """Admin-only routes. 401 if no session, 403 if session role isn't 'admin'."""
    @wraps(f)
    def decorated(*args, **kwargs):
        if 'admin_id' not in session:
            return jsonify({'success': False, 'message': 'Admin authentication required'}), 401
        if session.get('admin_role') != 'admin':
            return jsonify({'success': False, 'message': 'Admin role required'}), 403
        return f(*args, **kwargs)
    return decorated


# ── POST /api/admin/login ───────────────────────────────────────────────────
def _log_login_attempt(conn, admin_id, success):
    """Writes one row to admin_login_log. admin_id may be None (unknown email)."""
    c = conn.cursor()
    c.execute("""
        INSERT INTO admin_login_log(admin_id, ip_address, user_agent, success, created_at)
        VALUES (%s, %s, %s, %s, %s)
    """, (
        admin_id,
        request.remote_addr,
        request.headers.get('User-Agent', ''),
        success,
        datetime.utcnow().isoformat()
    ))


@auth_bp.route('/login', methods=['POST'])
def login():
    data     = request.json or {}
    email    = (data.get('email') or '').strip()
    password = data.get('password') or ''

    generic_failure = {'success': False, 'message': 'Invalid email or password'}

    if not email or not password:
        return jsonify(generic_failure), 401

    conn = get_pg_conn()
    c    = conn.cursor()
    c.execute(
        "SELECT id, name, role, status, password_hash FROM admin_users WHERE email=%s",
        (email,)
    )
    row = c.fetchone()

    if not row or not check_password_hash(row['password_hash'], password):
        # row may be None (unknown email) — log with admin_id=None either way,
        # since we deliberately don't want to leak which emails are registered.
        _log_login_attempt(conn, row['id'] if row else None, False)
        conn.commit()
        release_pg_conn(conn)
        return jsonify(generic_failure), 401

    if row['status'] != 'active':
        _log_login_attempt(conn, row['id'], False)
        conn.commit()
        release_pg_conn(conn)
        return jsonify(generic_failure), 401

    session['admin_id']   = row['id']
    session['admin_role'] = row['role']

    c.execute(
        "UPDATE admin_users SET last_login=%s WHERE id=%s",
        (datetime.utcnow().isoformat(), row['id'])
    )
    _log_login_attempt(conn, row['id'], True)
    conn.commit()
    release_pg_conn(conn)

    return jsonify({'success': True, 'role': row['role'], 'name': row['name']})


# ── POST /api/admin/logout ──────────────────────────────────────────────────
@auth_bp.route('/logout', methods=['POST'])
def logout():
    session.clear()
    return jsonify({'success': True})


# ── GET /api/admin/me ────────────────────────────────────────────────────────
@auth_bp.route('/me', methods=['GET'])
def me():
    if 'admin_id' not in session:
        return jsonify({'success': False}), 401

    conn = get_pg_conn()
    c    = conn.cursor()
    c.execute(
        "SELECT name, email, role FROM admin_users WHERE id=%s",
        (session['admin_id'],)
    )
    row = c.fetchone()
    release_pg_conn(conn)

    if not row:
        session.clear()
        return jsonify({'success': False}), 401

    return jsonify({
        'success': True,
        'name':    row['name'],
        'email':   row['email'],
        'role':    row['role']
    })


# ── GET /api/admin/health ────────────────────────────────────────────────────
@auth_bp.route('/health', methods=['GET'])
@require_admin_auth
def health():
    result = {
        'success':                True,
        'flask_status':           'ok',
        'postgres_status':        'ok',
        'groq_status':            'ok',
        'llm_fallback_rate_today': None,
        'recent_errors':          []
    }

    # Postgres check
    try:
        conn = get_pg_conn()
        c    = conn.cursor()
        c.execute("SELECT 1")
        c.fetchone()
        release_pg_conn(conn)
    except Exception:
        result['postgres_status'] = 'error'

    # Groq check — cheap presence check for the API key rather than a real
    # call, to keep this endpoint fast and free.
    try:
        if not os.environ.get('GROQ_API_KEY'):
            result['groq_status'] = 'error'
    except Exception:
        result['groq_status'] = 'error'

    # llm_fallback_rate_today intentionally left None: chat_history.engine
    # isn't being populated yet (see admin_tables.py note). The Settings
    # page already renders a graceful empty state for a null value.

    return jsonify(result)


# ── GET /api/admin/notifications/summary ─────────────────────────────────────
@auth_bp.route('/notifications/summary', methods=['GET'])
@require_admin_auth
def notifications_summary():
    conn = get_pg_conn()
    c    = conn.cursor()

    c.execute("SELECT COUNT(*) AS n FROM fraud_alerts WHERE status='unreviewed'")
    fraud_alerts_unread = c.fetchone()['n']

    c.execute("SELECT COUNT(*) AS n FROM kyc_submissions WHERE status='pending'")
    kyc_pending = c.fetchone()['n']

    release_pg_conn(conn)
    return jsonify({
        'success':             True,
        'fraud_alerts_unread': fraud_alerts_unread,
        'kyc_pending':         kyc_pending
    })


# ── GET /api/admin/users/search ──────────────────────────────────────────────
# Lightweight header search-bar autocomplete. Different from GET
# /api/admin/users (users.py) which is the full paginated admin table with
# role-masking — this one is always unmasked (gated admin-only on the
# frontend already).
@auth_bp.route('/users/search', methods=['GET'])
@require_admin_auth
def users_search():
    q = request.args.get('q', '').strip()
    if not q:
        return jsonify({'success': True, 'results': []})

    conn = get_pg_conn()
    c    = conn.cursor()
    c.execute("""
        SELECT account_number, name, email
        FROM   dashboard_users
        WHERE  name           ILIKE %s
            OR email          ILIKE %s
            OR account_number ILIKE %s
        ORDER  BY name
        LIMIT  10
    """, (f'%{q}%', f'%{q}%', f'%{q}%'))
    results = [dict(r) for r in c.fetchall()]
    release_pg_conn(conn)

    return jsonify({'success': True, 'results': results})