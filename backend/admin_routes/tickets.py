# admin_routes/tickets.py
# ─────────────────────────────────────────────────────────────────────────────
# Blueprint  : tickets_bp  →  registered at /api/admin/tickets
# Access     : admin AND banker (banker sees only tickets assigned to them)
# Connection : get_pg_conn / release_pg_conn from features.py (same pool)
#
# ASSUMPTIONS (tables/columns owned by admin_tables.py, not this file):
#   handoff_queue gets these columns added by admin_tables.py, beyond the
#   (id, account_number, reason, status, created_at) columns features.py
#   already creates:
#       assigned_to      INTEGER   -- admin_users.id of the claiming banker
#       resolution_note  TEXT
#       resolved_by      INTEGER   -- admin_users.id
#       cancel_reason    TEXT
#       cancelled_by     INTEGER   -- admin_users.id
#   admin_users(id, name, email, role, status, created_at, last_login) also
#   comes from admin_tables.py. If any of these columns/tables are missing,
#   every route below will raise — that migration is out of scope here per
#   the brief, so we do not silently fall back to something schema-lighter.
#
# The ticket-detail "messages" array is built from chat_history (owned by
# app.py) for the ticket's account, restricted to rows created at/after the
# ticket's created_at (i.e. the conversation since the handoff was raised).
# Each chat_history row holds one user turn + one AI turn, kept as a single
# { user_message, ai_response, created_at } entry per row — this is the
# shape TicketQueue.jsx actually reads (m.user_message / m.ai_response).
#
# Register in app.py:
#   from admin_routes.tickets import tickets_bp
#   app.register_blueprint(tickets_bp)
# ─────────────────────────────────────────────────────────────────────────────

from flask import Blueprint, request, jsonify, session
from datetime import datetime
from features import get_pg_conn, release_pg_conn
from admin_routes.auth import require_admin_auth as admin_required

tickets_bp = Blueprint('tickets', __name__, url_prefix='/api/admin/tickets')


def _expand_chat_row(row):
    """One chat_history row -> one message entry, kept in the
    {user_message, ai_response, created_at} shape TicketQueue.jsx renders
    (m.user_message / m.ai_response), not split into sender/message pairs."""
    return [{
        'user_message': row.get('user_message'),
        'ai_response':  row.get('ai_response'),
        'created_at':   row['created_at']
    }]


# ── GET /api/admin/tickets/ ─────────────────────────────────────────────────
# NOTE: trailing slash is required to exactly match the frontend's call to
# GET /api/admin/tickets/?status=&search= — url_prefix + '/' below resolves
# to exactly /api/admin/tickets/.
@tickets_bp.route('/', methods=['GET'])
@admin_required
def list_tickets():
    status_f = request.args.get('status', '').strip()
    search   = request.args.get('search', '').strip()

    admin_id   = session['admin_id']
    admin_role = session.get('admin_role')

    conn = get_pg_conn()
    c    = conn.cursor()

    conditions, params = [], []

    # Bankers only ever see tickets assigned to them; admins see everything.
    if admin_role != 'admin':
        conditions.append("h.assigned_to = %s")
        params.append(admin_id)

    if status_f:
        conditions.append("h.status = %s")
        params.append(status_f)

    if search:
        conditions.append("(du.name ILIKE %s OR h.account_number ILIKE %s)")
        params.extend([f'%{search}%', f'%{search}%'])

    where = f"WHERE {' AND '.join(conditions)}" if conditions else ""

    c.execute(f"""
        SELECT
            h.id,
            h.account_number   AS account,
            COALESCE(du.name, 'Unknown') AS name,
            h.reason,
            h.status,
            h.created_at,
            au.name             AS assigned_to
        FROM   handoff_queue h
        LEFT   JOIN dashboard_users du ON du.account_number = h.account_number
        LEFT   JOIN admin_users     au ON au.id             = h.assigned_to
        {where}
        ORDER  BY h.created_at DESC
    """, params)

    tickets = [dict(r) for r in c.fetchall()]
    release_pg_conn(conn)
    return jsonify({'success': True, 'tickets': tickets})


# ── GET /api/admin/tickets/<id> ─────────────────────────────────────────────
@tickets_bp.route('/<int:ticket_id>', methods=['GET'])
@admin_required
def get_ticket(ticket_id):
    admin_id   = session['admin_id']
    admin_role = session.get('admin_role')

    conn = get_pg_conn()
    c    = conn.cursor()

    c.execute("""
        SELECT
            h.id, h.account_number AS account, h.reason, h.status,
            h.created_at, h.assigned_to,
            COALESCE(du.name, 'Unknown') AS name
        FROM   handoff_queue h
        LEFT   JOIN dashboard_users du ON du.account_number = h.account_number
        WHERE  h.id = %s
    """, (ticket_id,))
    row = c.fetchone()

    if not row:
        release_pg_conn(conn)
        return jsonify({'success': False, 'message': 'Ticket not found'}), 404

    # Bankers may only view their own assigned tickets.
    if admin_role != 'admin' and row['assigned_to'] != admin_id:
        release_pg_conn(conn)
        return jsonify({'success': False, 'message': 'Forbidden'}), 403

    ticket = {
        'id':         row['id'],
        'account':    row['account'],
        'name':       row['name'],
        'reason':     row['reason'],
        'status':     row['status'],
        'created_at': row['created_at']
    }

    c.execute("""
        SELECT user_message, ai_response, created_at
        FROM   chat_history
        WHERE  account_number = %s AND created_at >= %s
        ORDER  BY created_at ASC
    """, (row['account'], row['created_at']))

    messages = []
    for r in c.fetchall():
        messages.extend(_expand_chat_row(dict(r)))

    release_pg_conn(conn)
    return jsonify({'success': True, 'ticket': ticket, 'messages': messages})


# ── POST /api/admin/tickets/<id>/claim ──────────────────────────────────────
@tickets_bp.route('/<int:ticket_id>/claim', methods=['POST'])
@admin_required
def claim_ticket(ticket_id):
    admin_id = session['admin_id']

    conn = get_pg_conn()
    c    = conn.cursor()

    c.execute(
        "UPDATE handoff_queue SET status='in_progress', assigned_to=%s "
        "WHERE id=%s AND status='pending'",
        (admin_id, ticket_id)
    )
    if c.rowcount == 0:
        conn.rollback()
        release_pg_conn(conn)
        return jsonify({'success': False, 'message': 'Ticket not found or already claimed'}), 400

    c.execute("SELECT account_number FROM handoff_queue WHERE id=%s", (ticket_id,))
    row = c.fetchone()
    if row:
        c.execute("""
            INSERT INTO conversation_state(account_number, mode, assigned_to, updated_at)
            VALUES (%s, 'human', %s, %s)
            ON CONFLICT(account_number) DO UPDATE SET
                mode='human', assigned_to=EXCLUDED.assigned_to, updated_at=EXCLUDED.updated_at
        """, (row['account_number'], str(admin_id), datetime.utcnow().isoformat()))

    conn.commit()
    release_pg_conn(conn)
    return jsonify({'success': True})


# ── POST /api/admin/tickets/<id>/resolve ────────────────────────────────────
@tickets_bp.route('/<int:ticket_id>/resolve', methods=['POST'])
@admin_required
def resolve_ticket(ticket_id):
    data            = request.json or {}
    resolution_note = data.get('resolution_note', '').strip()
    admin_id        = session['admin_id']

    conn = get_pg_conn()
    c    = conn.cursor()

    c.execute("""
        UPDATE handoff_queue
        SET    status='resolved', resolution_note=%s, resolved_by=%s
        WHERE  id=%s
    """, (resolution_note, admin_id, ticket_id))

    if c.rowcount == 0:
        conn.rollback()
        release_pg_conn(conn)
        return jsonify({'success': False, 'message': 'Ticket not found'}), 404

    c.execute("SELECT account_number FROM handoff_queue WHERE id=%s", (ticket_id,))
    row = c.fetchone()
    if row:
        c.execute("""
            INSERT INTO conversation_state(account_number, mode, assigned_to, updated_at)
            VALUES (%s, 'bot', NULL, %s)
            ON CONFLICT(account_number) DO UPDATE SET
                mode='bot', assigned_to=NULL, updated_at=EXCLUDED.updated_at
        """, (row['account_number'], datetime.utcnow().isoformat()))

    conn.commit()
    release_pg_conn(conn)
    return jsonify({'success': True})


# ── POST /api/admin/tickets/<id>/cancel ─────────────────────────────────────
@tickets_bp.route('/<int:ticket_id>/cancel', methods=['POST'])
@admin_required
def cancel_ticket(ticket_id):
    data     = request.json or {}
    reason   = data.get('reason', '').strip()
    admin_id = session['admin_id']

    conn = get_pg_conn()
    c    = conn.cursor()

    c.execute("""
        UPDATE handoff_queue
        SET    status='canceled', cancel_reason=%s, cancelled_by=%s
        WHERE  id=%s
    """, (reason, admin_id, ticket_id))

    if c.rowcount == 0:
        conn.rollback()
        release_pg_conn(conn)
        return jsonify({'success': False, 'message': 'Ticket not found'}), 404

    c.execute("SELECT account_number FROM handoff_queue WHERE id=%s", (ticket_id,))
    row = c.fetchone()
    if row:
        c.execute("""
            INSERT INTO conversation_state(account_number, mode, assigned_to, updated_at)
            VALUES (%s, 'bot', NULL, %s)
            ON CONFLICT(account_number) DO UPDATE SET
                mode='bot', assigned_to=NULL, updated_at=EXCLUDED.updated_at
        """, (row['account_number'], datetime.utcnow().isoformat()))

    conn.commit()
    release_pg_conn(conn)
    return jsonify({'success': True})