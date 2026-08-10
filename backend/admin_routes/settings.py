# admin_routes/settings.py
# ─────────────────────────────────────────────────────────────────────────────
# Blueprint  : settings_bp  →  registered at /api/admin/settings
# Access     : admin only, EXCEPT /change-password which any logged-in
#              admin or banker can use on their own account.
#
# ASSUMPTIONS (tables owned by admin_tables.py, not this file):
#   admin_users(id, name, email, password_hash, role, status, created_at,
#               last_login)
#   system_config(config_key, config_value, updated_by, updated_at)
#
# NOTE: GET /api/admin/settings/health is intentionally NOT here — it lives
# in admin_routes/auth.py per the brief.
#
# Register in app.py:
#   from admin_routes.settings import settings_bp
#   app.register_blueprint(settings_bp)
# ─────────────────────────────────────────────────────────────────────────────

from flask import Blueprint, request, jsonify, session
from datetime import datetime
from werkzeug.security import generate_password_hash, check_password_hash
from features import get_pg_conn, release_pg_conn
from admin_routes.auth import require_admin_auth as admin_required, require_admin_role as admin_only

settings_bp = Blueprint('settings', __name__, url_prefix='/api/admin/settings')


# ── GET /api/admin/settings/admins ───────────────────────────────────────────
@settings_bp.route('/admins', methods=['GET'])
@admin_only
def list_admins():
    conn = get_pg_conn()
    c    = conn.cursor()
    c.execute("""
        SELECT id, name, email, role, status, created_at, last_login
        FROM   admin_users
        ORDER  BY created_at ASC
    """)
    admins = [dict(r) for r in c.fetchall()]
    release_pg_conn(conn)
    return jsonify({'success': True, 'admins': admins})


# ── POST /api/admin/settings/admins ──────────────────────────────────────────
@settings_bp.route('/admins', methods=['POST'])
@admin_only
def create_admin():
    data     = request.json or {}
    name     = data.get('name', '').strip()
    email    = data.get('email', '').strip().lower()
    password = data.get('password', '')
    role     = data.get('role', '').strip()

    if not name or not email or not password or role not in ('admin', 'banker'):
        return jsonify({'success': False, 'message': 'name, email, password, and a valid role are required'}), 400

    conn = get_pg_conn()
    c    = conn.cursor()

    c.execute("SELECT id FROM admin_users WHERE email = %s", (email,))
    if c.fetchone():
        release_pg_conn(conn)
        return jsonify({'success': False, 'message': 'An account with that email already exists'}), 409

    password_hash = generate_password_hash(password)
    now = datetime.utcnow().isoformat()

    c.execute("""
        INSERT INTO admin_users(name, email, password_hash, role, status, created_at)
        VALUES (%s, %s, %s, %s, 'active', %s)
        RETURNING id
    """, (name, email, password_hash, role, now))
    new_id = c.fetchone()['id']

    conn.commit()
    release_pg_conn(conn)
    return jsonify({'success': True, 'id': new_id})


# ── PATCH /api/admin/settings/admins/<id> ────────────────────────────────────
@settings_bp.route('/admins/<int:admin_user_id>', methods=['PATCH'])
@admin_only
def update_admin(admin_user_id):
    if admin_user_id == session['admin_id']:
        return jsonify({'success': False, 'message': 'You cannot modify your own role or status'}), 400

    data   = request.json or {}
    role   = data.get('role')
    status = data.get('status')

    if role is None and status is None:
        return jsonify({'success': False, 'message': 'Nothing to update'}), 400
    if role is not None and role not in ('admin', 'banker'):
        return jsonify({'success': False, 'message': "role must be 'admin' or 'banker'"}), 400
    if status is not None and status not in ('active', 'inactive'):
        return jsonify({'success': False, 'message': "status must be 'active' or 'inactive'"}), 400

    conn = get_pg_conn()
    c    = conn.cursor()

    c.execute("SELECT id FROM admin_users WHERE id = %s", (admin_user_id,))
    if not c.fetchone():
        release_pg_conn(conn)
        return jsonify({'success': False, 'message': 'Admin not found'}), 404

    if role is not None and status is not None:
        c.execute("UPDATE admin_users SET role=%s, status=%s WHERE id=%s", (role, status, admin_user_id))
    elif role is not None:
        c.execute("UPDATE admin_users SET role=%s WHERE id=%s", (role, admin_user_id))
    else:
        c.execute("UPDATE admin_users SET status=%s WHERE id=%s", (status, admin_user_id))

    conn.commit()
    release_pg_conn(conn)
    return jsonify({'success': True})


# ── GET /api/admin/settings/config ───────────────────────────────────────────
@settings_bp.route('/config', methods=['GET'])
@admin_only
def get_config():
    conn = get_pg_conn()
    c    = conn.cursor()
    c.execute("SELECT config_key, config_value FROM system_config")
    rows = c.fetchall()
    release_pg_conn(conn)

    result = {'success': True}
    for r in rows:
        result[r['config_key']] = r['config_value']
    return jsonify(result)


# ── PATCH /api/admin/settings/config ─────────────────────────────────────────
@settings_bp.route('/config', methods=['PATCH'])
@admin_only
def update_config():
    data          = request.json or {}
    config_key    = data.get('config_key', '').strip()
    config_value  = data.get('config_value')

    if not config_key or config_value is None:
        return jsonify({'success': False, 'message': 'config_key and config_value are required'}), 400

    conn = get_pg_conn()
    c    = conn.cursor()

    c.execute("""
        UPDATE system_config
        SET    config_value = %s, updated_by = %s, updated_at = NOW()::text
        WHERE  config_key = %s
    """, (str(config_value), session['admin_id'], config_key))

    if c.rowcount == 0:
        conn.rollback()
        release_pg_conn(conn)
        return jsonify({'success': False, 'message': f'Unknown config_key: {config_key}'}), 404

    conn.commit()
    release_pg_conn(conn)
    return jsonify({'success': True})


# ── POST /api/admin/settings/change-password ─────────────────────────────────
@settings_bp.route('/change-password', methods=['POST'])
@admin_required
def change_password():
    data             = request.json or {}
    current_password = data.get('currentPassword', '')
    new_password     = data.get('newPassword', '')
    admin_id         = session['admin_id']

    if len(new_password) < 4:
        return jsonify({'success': False, 'message': 'New password must be at least 4 characters'}), 400

    conn = get_pg_conn()
    c    = conn.cursor()

    c.execute("SELECT password_hash FROM admin_users WHERE id = %s", (admin_id,))
    row = c.fetchone()
    if not row or not check_password_hash(row['password_hash'], current_password):
        release_pg_conn(conn)
        return jsonify({'success': False, 'message': 'Current password is incorrect'}), 400

    new_hash = generate_password_hash(new_password)
    c.execute("UPDATE admin_users SET password_hash = %s WHERE id = %s", (new_hash, admin_id))

    conn.commit()
    release_pg_conn(conn)
    return jsonify({'success': True})