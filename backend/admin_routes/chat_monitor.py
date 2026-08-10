# admin_routes/chat_monitor.py
# ─────────────────────────────────────────────────────────────────────────────
# Blueprint  : chat_monitor_bp  →  registered at /api/admin/chat-monitor
# Access     : admin AND banker (require_admin_auth — no role restriction)
#
# Register in app.py:
#   from admin_routes.chat_monitor import chat_monitor_bp
#   app.register_blueprint(chat_monitor_bp)
# ─────────────────────────────────────────────────────────────────────────────

from datetime import datetime

from flask import Blueprint, request, jsonify

from features import get_pg_conn, release_pg_conn
from admin_routes.auth import require_admin_auth

chat_monitor_bp = Blueprint('chat_monitor', __name__, url_prefix='/api/admin/chat-monitor')


# ── GET /api/admin/chat-monitor/conversations ────────────────────────────────
@chat_monitor_bp.route('/conversations', methods=['GET'])
@require_admin_auth
def list_conversations():
    mode_filter = request.args.get('mode_filter', 'all').strip()

    conn = get_pg_conn()
    c    = conn.cursor()

    conditions, params = [], []
    if mode_filter == 'bot':
        conditions.append("cs.mode = 'bot'")
    elif mode_filter == 'human':
        conditions.append("cs.mode = 'human'")
    elif mode_filter == 'unclaimed':
        conditions.append("cs.mode = 'human' AND cs.assigned_to IS NULL")

    where = f"WHERE {' AND '.join(conditions)}" if conditions else ""

    # assigned_to on conversation_state is stored as TEXT (see claim_ticket()
    # in tickets.py, which does str(admin_id)) — and can also hold legacy
    # non-numeric values like 'banker-1' from the original customer-facing
    # /handoff/claim route. Casting admin_users.id to text for the join
    # (rather than casting assigned_to to integer) means a legacy string
    # value just fails to match instead of throwing a cast error.
    c.execute(f"""
        SELECT
            cs.account_number,
            COALESCE(du.name, 'Unknown') AS name,
            cs.mode,
            cs.assigned_to,
            au.name AS assigned_to_name,
            latest.last_message_preview,
            latest.last_activity
        FROM conversation_state cs
        LEFT JOIN dashboard_users du ON du.account_number = cs.account_number
        LEFT JOIN admin_users au ON au.id::text = cs.assigned_to
        LEFT JOIN LATERAL (
            SELECT
                COALESCE(ch.ai_response, ch.user_message) AS last_message_preview,
                ch.created_at AS last_activity
            FROM chat_history ch
            WHERE ch.account_number = cs.account_number
            ORDER BY ch.created_at DESC
            LIMIT 1
        ) latest ON true
        {where}
        ORDER BY latest.last_activity DESC NULLS LAST
    """, params)

    conversations = []
    for r in c.fetchall():
        d = dict(r)
        # Prefer the resolved banker name; fall back to whatever raw value
        # was stored (e.g. a legacy 'banker-1') rather than showing nothing.
        if d.get('assigned_to_name'):
            d['assigned_to'] = d['assigned_to_name']
        d.pop('assigned_to_name', None)
        conversations.append(d)

    release_pg_conn(conn)

    return jsonify({'success': True, 'conversations': conversations})


# ── GET /api/admin/chat-monitor/conversations/<account_number> ───────────────
@chat_monitor_bp.route('/conversations/<account_number>', methods=['GET'])
@require_admin_auth
def get_conversation(account_number):
    conn = get_pg_conn()
    c    = conn.cursor()

    c.execute("""
        SELECT id, user_message, ai_response, sender, engine, created_at
        FROM   chat_history
        WHERE  account_number = %s
        ORDER  BY created_at ASC
    """, (account_number,))
    messages = [dict(r) for r in c.fetchall()]

    release_pg_conn(conn)
    return jsonify({'success': True, 'messages': messages})


# ── POST /api/admin/chat-monitor/conversations/<account_number>/reply ────────
@chat_monitor_bp.route('/conversations/<account_number>/reply', methods=['POST'])
@require_admin_auth
def reply(account_number):
    data    = request.json or {}
    message = (data.get('message') or '').strip()

    if not message:
        return jsonify({'success': False, 'message': 'message is required'}), 400

    conn = get_pg_conn()
    c    = conn.cursor()
    c.execute("""
        INSERT INTO chat_history(account_number, user_message, ai_response, intent, created_at, sender)
        VALUES (%s, %s, %s, 'banker_reply', %s, 'banker')
    """, (account_number, '[Banker message]', message, datetime.utcnow().isoformat()))
    conn.commit()
    release_pg_conn(conn)

    return jsonify({'success': True})


# ── POST /api/admin/chat-monitor/conversations/<account_number>/return-to-bot ─
@chat_monitor_bp.route('/conversations/<account_number>/return-to-bot', methods=['POST'])
@require_admin_auth
def return_to_bot(account_number):
    # Same UPSERT pattern already used by features.py's resolve()/cancel().
    conn = get_pg_conn()
    c    = conn.cursor()
    c.execute("""
        INSERT INTO conversation_state(account_number, mode, assigned_to, updated_at)
        VALUES (%s, 'bot', NULL, %s)
        ON CONFLICT(account_number) DO UPDATE SET
            mode='bot', assigned_to=NULL, updated_at=EXCLUDED.updated_at
    """, (account_number, datetime.utcnow().isoformat()))
    conn.commit()
    release_pg_conn(conn)

    return jsonify({'success': True})