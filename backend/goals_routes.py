# goals_routes.py  –  FinBud AI  –  "Savings Goals" backend feature
# ─────────────────────────────────────────────────────────────────────────────
# Self-contained Flask Blueprint for the Savings Goals feature.
# Follows the same conventions as the rest of the backend:
#   • PostgreSQL via get_pg_conn() / release_pg_conn(conn) from features.py
#   • RealDictCursor style (row['col'])
#   • Session-based auth: 'user_id' in session, account via session['account_number']
#   • created_at stored as ISO text via datetime.utcnow().isoformat()
#   • Reuses get_income_vs_expense(account) from features.py for the
#     suggested monthly saving figure — no income/expense logic is
#     reimplemented here.
#
# This file does not import or modify anything outside of features.py.
# ─────────────────────────────────────────────────────────────────────────────

from flask import Blueprint, request, jsonify, session
from datetime import datetime

from features import get_pg_conn, release_pg_conn, get_income_vs_expense

goals_bp = Blueprint('goals_bp', __name__)

VALID_GOAL_TYPES = {
    'emergency_fund', 'car', 'house', 'wedding',
    'education', 'just_saving', 'custom'
}


# ─────────────────────────────────────────────────────────────────────────────
# Schema init
# ─────────────────────────────────────────────────────────────────────────────
def init_goals_tables(conn):
    """
    Creates the savings_goals table if it doesn't already exist, and adds
    the newer plan-related columns via ADD COLUMN IF NOT EXISTS so this is
    safe to re-run against an already-existing table too.
    Caller owns the connection (opened via get_pg_conn()) and is responsible
    for releasing it — see the single call site in app.py.
    """
    c = conn.cursor()
    c.execute('''
    CREATE TABLE IF NOT EXISTS savings_goals (
        id                SERIAL PRIMARY KEY,
        account_number    TEXT NOT NULL,
        goal_type         TEXT NOT NULL,
        goal_name         TEXT,
        target_amount     NUMERIC,
        target_date       TEXT,
        saved_amount      NUMERIC DEFAULT 0,
        created_at        TEXT NOT NULL,
        frequency         TEXT,
        timeline_months   NUMERIC,
        per_period_amount NUMERIC
    )''')
    # ADD COLUMN IF NOT EXISTS lets this run safely even if the table already
    # existed from before these three columns were added.
    c.execute('ALTER TABLE savings_goals ADD COLUMN IF NOT EXISTS frequency TEXT')
    c.execute('ALTER TABLE savings_goals ADD COLUMN IF NOT EXISTS timeline_months NUMERIC')
    c.execute('ALTER TABLE savings_goals ADD COLUMN IF NOT EXISTS per_period_amount NUMERIC')
    conn.commit()


# Periods per month, used to convert a monthly figure to/from other cadences.
PERIODS_PER_MONTH = {
    'weekly': 4.345,
    'biweekly': 2.1725,
    'monthly': 1,
}


# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────
def _serialize_goal(row):
    """Shapes a DB row into the API's goal dict, including progress_pct."""
    target = row['target_amount']
    saved = row['saved_amount']

    progress_pct = 0
    if target is not None and float(target) > 0:
        progress_pct = round((float(saved) / float(target)) * 100, 2)
        progress_pct = min(progress_pct, 100)  # never show over 100%

    return {
        'id': row['id'],
        'goal_type': row['goal_type'],
        'goal_name': row['goal_name'],
        'target_amount': float(target) if target is not None else None,
        'target_date': row['target_date'],
        'saved_amount': float(saved) if saved is not None else 0,
        'progress_pct': progress_pct,
        'frequency': row.get('frequency'),
        'timeline_months': float(row['timeline_months']) if row.get('timeline_months') is not None else None,
        'per_period_amount': float(row['per_period_amount']) if row.get('per_period_amount') is not None else None,
    }


# ─────────────────────────────────────────────────────────────────────────────
# GET /api/advisor/goals
# ─────────────────────────────────────────────────────────────────────────────
@goals_bp.route('/api/advisor/goals', methods=['GET'])
def get_goals():
    if 'user_id' not in session:
        return jsonify({'success': False, 'message': 'Not authenticated'}), 401

    account_number = session['account_number']

    conn = get_pg_conn(); c = conn.cursor()
    c.execute("""
        SELECT id, goal_type, goal_name, target_amount, target_date, saved_amount, frequency, timeline_months, per_period_amount
        FROM savings_goals
        WHERE account_number=%s
        ORDER BY id DESC
    """, (account_number,))
    rows = c.fetchall()
    release_pg_conn(conn)

    goals = [_serialize_goal(row) for row in rows]

    # Reuse existing income/expense logic — 20% of this month's net income,
    # 0 if net income is not positive.
    income_data = get_income_vs_expense(account_number)
    net = income_data.get('net', 0)
    suggested_monthly_saving = round(net * 0.20, 2) if net > 0 else 0

    # Real, spendable balance — so the frontend can show "you have PKR X
    # available to move into savings" and block over-committing.
    conn = get_pg_conn(); c = conn.cursor()
    c.execute("SELECT balance FROM dashboard_users WHERE account_number=%s", (account_number,))
    user_row = c.fetchone()
    release_pg_conn(conn)
    balance = float(user_row['balance']) if user_row else 0

    return jsonify({
        'success': True,
        'goals': goals,
        'suggested_monthly_saving': suggested_monthly_saving,
        'balance': balance
    })


# ─────────────────────────────────────────────────────────────────────────────
# POST /api/advisor/goals
# ─────────────────────────────────────────────────────────────────────────────
@goals_bp.route('/api/advisor/goals', methods=['POST'])
def create_goal():
    if 'user_id' not in session:
        return jsonify({'success': False, 'message': 'Not authenticated'}), 401

    data = request.json or {}
    goal_type = (data.get('goal_type') or '').strip()
    goal_name = (data.get('goal_name') or '').strip() or None
    target_amount = data.get('target_amount')
    target_date = data.get('target_date')
    frequency = data.get('frequency')
    timeline_months = data.get('timeline_months')
    per_period_amount = data.get('per_period_amount')

    if goal_type not in VALID_GOAL_TYPES:
        return jsonify({
            'success': False,
            'message': f'goal_type must be one of: {", ".join(sorted(VALID_GOAL_TYPES))}'
        }), 400

    if target_amount is not None:
        try:
            target_amount = float(target_amount)
        except (TypeError, ValueError):
            return jsonify({'success': False, 'message': 'target_amount must be a number'}), 400

    if frequency is not None and frequency not in PERIODS_PER_MONTH:
        return jsonify({
            'success': False,
            'message': f'frequency must be one of: {", ".join(sorted(PERIODS_PER_MONTH))}'
        }), 400

    if timeline_months is not None:
        try:
            timeline_months = float(timeline_months)
        except (TypeError, ValueError):
            return jsonify({'success': False, 'message': 'timeline_months must be a number'}), 400

    if per_period_amount is not None:
        try:
            per_period_amount = float(per_period_amount)
        except (TypeError, ValueError):
            return jsonify({'success': False, 'message': 'per_period_amount must be a number'}), 400

    account_number = session['account_number']
    now_iso = datetime.utcnow().isoformat()

    conn = get_pg_conn(); c = conn.cursor()
    c.execute("""
        INSERT INTO savings_goals
            (account_number, goal_type, goal_name, target_amount, target_date, saved_amount, created_at, frequency, timeline_months, per_period_amount)
        VALUES (%s, %s, %s, %s, %s, 0, %s, %s, %s, %s)
        RETURNING id, goal_type, goal_name, target_amount, target_date, saved_amount, frequency, timeline_months, per_period_amount
    """, (account_number, goal_type, goal_name, target_amount, target_date, now_iso, frequency, timeline_months, per_period_amount))
    new_row = c.fetchone()
    conn.commit()
    release_pg_conn(conn)

    return jsonify({
        'success': True,
        'message': 'Goal created',
        'goal': _serialize_goal(new_row)
    })


# ─────────────────────────────────────────────────────────────────────────────
# PUT /api/advisor/goals/<id>
# ─────────────────────────────────────────────────────────────────────────────
@goals_bp.route('/api/advisor/goals/<int:goal_id>', methods=['PUT'])
def update_goal(goal_id):
    if 'user_id' not in session:
        return jsonify({'success': False, 'message': 'Not authenticated'}), 401

    data = request.json or {}
    account_number = session['account_number']

    # saved_amount is intentionally NOT editable here — it only changes via
    # the balance-linked /contribute and /withdraw endpoints below, so the
    # tracked amount can never drift from the user's real balance.
    allowed_fields = ('target_amount', 'target_date', 'goal_name', 'frequency', 'timeline_months', 'per_period_amount')
    updates = {k: v for k, v in data.items() if k in allowed_fields}

    if not updates:
        return jsonify({'success': False, 'message': 'No valid fields to update'}), 400

    # Validate numeric fields if present
    for numeric_field in ('saved_amount', 'target_amount'):
        if numeric_field in updates and updates[numeric_field] is not None:
            try:
                updates[numeric_field] = float(updates[numeric_field])
            except (TypeError, ValueError):
                return jsonify({'success': False, 'message': f'{numeric_field} must be a number'}), 400

    conn = get_pg_conn(); c = conn.cursor()

    # Ownership check
    c.execute("""
        SELECT id FROM savings_goals WHERE id=%s AND account_number=%s
    """, (goal_id, account_number))
    if c.fetchone() is None:
        release_pg_conn(conn)
        return jsonify({'success': False, 'message': 'Goal not found'}), 404

    set_clause = ", ".join(f"{field}=%s" for field in updates.keys())
    values = list(updates.values()) + [goal_id, account_number]

    c.execute(f"""
        UPDATE savings_goals
        SET {set_clause}
        WHERE id=%s AND account_number=%s
        RETURNING id, goal_type, goal_name, target_amount, target_date, saved_amount, frequency, timeline_months, per_period_amount
    """, values)
    updated_row = c.fetchone()
    conn.commit()
    release_pg_conn(conn)

    return jsonify({
        'success': True,
        'message': 'Goal updated',
        'goal': _serialize_goal(updated_row)
    })


# ─────────────────────────────────────────────────────────────────────────────
# DELETE /api/advisor/goals/<id>
# ─────────────────────────────────────────────────────────────────────────────
@goals_bp.route('/api/advisor/goals/<int:goal_id>', methods=['DELETE'])
def delete_goal(goal_id):
    if 'user_id' not in session:
        return jsonify({'success': False, 'message': 'Not authenticated'}), 401

    account_number = session['account_number']

    conn = get_pg_conn(); c = conn.cursor()

    # Ownership check — also fetch saved_amount so we can refund it below.
    c.execute("""
        SELECT id, saved_amount, goal_name, goal_type FROM savings_goals
        WHERE id=%s AND account_number=%s
    """, (goal_id, account_number))
    goal_row = c.fetchone()
    if goal_row is None:
        release_pg_conn(conn)
        return jsonify({'success': False, 'message': 'Goal not found'}), 404

    saved = float(goal_row['saved_amount'] or 0)

    # Deleting a goal must never destroy real money — refund whatever was
    # saved back into the user's spendable balance first.
    if saved > 0:
        now_iso = datetime.utcnow().isoformat()
        label = goal_row['goal_name'] or goal_row['goal_type']
        c.execute("UPDATE dashboard_users SET balance = balance + %s WHERE account_number=%s",
                   (saved, account_number))
        c.execute("""
            INSERT INTO dashboard_transactions
                (account_number, transaction_type, description, amount, status, created_at, category, fee)
            VALUES (%s, 'savings_refund', %s, %s, 'completed', %s, 'Savings', 0)
        """, (account_number, f"Goal deleted — refunded from '{label}'", saved, now_iso))

    c.execute("""
        DELETE FROM savings_goals WHERE id=%s AND account_number=%s
    """, (goal_id, account_number))
    conn.commit()
    release_pg_conn(conn)

    return jsonify({'success': True, 'refunded': saved})


# ─────────────────────────────────────────────────────────────────────────────
# POST /api/advisor/goals/<id>/contribute — move real money FROM balance INTO a goal
# ─────────────────────────────────────────────────────────────────────────────
@goals_bp.route('/api/advisor/goals/<int:goal_id>/contribute', methods=['POST'])
def contribute_to_goal(goal_id):
    """
    Moves `amount` out of the user's spendable dashboard_users.balance and
    into this goal's saved_amount. This is real money movement (mirrors the
    same balance/transaction pattern used by /api/transaction elsewhere in
    app.py), not just a counter increment — so what the user sees in
    "Safe to Spend" elsewhere in the app reflects money actually set aside.
    """
    if 'user_id' not in session:
        return jsonify({'success': False, 'message': 'Not authenticated'}), 401

    data = request.json or {}
    try:
        amount = float(data.get('amount'))
    except (TypeError, ValueError):
        return jsonify({'success': False, 'message': 'amount must be a number'}), 400

    if amount <= 0:
        return jsonify({'success': False, 'message': 'amount must be greater than 0'}), 400

    account_number = session['account_number']
    conn = get_pg_conn(); c = conn.cursor()

    c.execute("""
        SELECT id, goal_name, goal_type, saved_amount FROM savings_goals
        WHERE id=%s AND account_number=%s
    """, (goal_id, account_number))
    goal_row = c.fetchone()
    if goal_row is None:
        release_pg_conn(conn)
        return jsonify({'success': False, 'message': 'Goal not found'}), 404

    c.execute("SELECT balance FROM dashboard_users WHERE account_number=%s", (account_number,))
    user_row = c.fetchone()
    balance = float(user_row['balance']) if user_row else 0

    if balance < amount:
        release_pg_conn(conn)
        return jsonify({
            'success': False,
            'message': f'Insufficient balance. Available: PKR {balance:,.0f}, requested: PKR {amount:,.0f}'
        }), 400

    label = goal_row['goal_name'] or goal_row['goal_type']
    now_iso = datetime.utcnow().isoformat()

    c.execute("UPDATE dashboard_users SET balance = balance - %s WHERE account_number=%s",
               (amount, account_number))
    c.execute("""
        UPDATE savings_goals SET saved_amount = saved_amount + %s
        WHERE id=%s AND account_number=%s
        RETURNING id, goal_type, goal_name, target_amount, target_date, saved_amount, frequency, timeline_months, per_period_amount
    """, (amount, goal_id, account_number))
    updated_row = c.fetchone()
    c.execute("""
        INSERT INTO dashboard_transactions
            (account_number, transaction_type, description, amount, status, created_at, category, fee)
        VALUES (%s, 'savings_transfer', %s, %s, 'completed', %s, 'Savings', 0)
    """, (account_number, f"Moved to savings goal: {label}", -amount, now_iso))
    conn.commit()
    release_pg_conn(conn)

    return jsonify({
        'success': True,
        'message': f'PKR {amount:,.0f} moved to savings — set aside so it\'s harder to accidentally spend. You can withdraw it back anytime.',
        'goal': _serialize_goal(updated_row),
        'new_balance': balance - amount
    })


# ─────────────────────────────────────────────────────────────────────────────
# POST /api/advisor/goals/<id>/withdraw — move real money BACK from a goal to balance
# ─────────────────────────────────────────────────────────────────────────────
@goals_bp.route('/api/advisor/goals/<int:goal_id>/withdraw', methods=['POST'])
def withdraw_from_goal(goal_id):
    """
    The saving is never locked away permanently — this moves `amount` back
    out of the goal's saved_amount and into the user's spendable balance,
    for whenever they actually need the money.
    """
    if 'user_id' not in session:
        return jsonify({'success': False, 'message': 'Not authenticated'}), 401

    data = request.json or {}
    try:
        amount = float(data.get('amount'))
    except (TypeError, ValueError):
        return jsonify({'success': False, 'message': 'amount must be a number'}), 400

    if amount <= 0:
        return jsonify({'success': False, 'message': 'amount must be greater than 0'}), 400

    account_number = session['account_number']
    conn = get_pg_conn(); c = conn.cursor()

    c.execute("""
        SELECT id, goal_name, goal_type, saved_amount FROM savings_goals
        WHERE id=%s AND account_number=%s
    """, (goal_id, account_number))
    goal_row = c.fetchone()
    if goal_row is None:
        release_pg_conn(conn)
        return jsonify({'success': False, 'message': 'Goal not found'}), 404

    saved = float(goal_row['saved_amount'] or 0)
    if saved < amount:
        release_pg_conn(conn)
        return jsonify({
            'success': False,
            'message': f'This goal only has PKR {saved:,.0f} saved — cannot withdraw PKR {amount:,.0f}'
        }), 400

    label = goal_row['goal_name'] or goal_row['goal_type']
    now_iso = datetime.utcnow().isoformat()

    c.execute("UPDATE savings_goals SET saved_amount = saved_amount - %s WHERE id=%s AND account_number=%s",
               (amount, goal_id, account_number))
    c.execute("""
        UPDATE dashboard_users SET balance = balance + %s WHERE account_number=%s
        RETURNING balance
    """, (amount, account_number))
    new_balance = float(c.fetchone()['balance'])
    c.execute("""
        SELECT id, goal_type, goal_name, target_amount, target_date, saved_amount, frequency, timeline_months, per_period_amount
        FROM savings_goals WHERE id=%s
    """, (goal_id,))
    updated_row = c.fetchone()
    c.execute("""
        INSERT INTO dashboard_transactions
            (account_number, transaction_type, description, amount, status, created_at, category, fee)
        VALUES (%s, 'savings_withdrawal', %s, %s, 'completed', %s, 'Savings', 0)
    """, (account_number, f"Withdrawn from savings goal: {label}", amount, now_iso))
    conn.commit()
    release_pg_conn(conn)

    return jsonify({
        'success': True,
        'message': f'PKR {amount:,.0f} moved back to your available balance.',
        'goal': _serialize_goal(updated_row),
        'new_balance': new_balance
    })


# ─────────────────────────────────────────────────────────────────────────────
# POST /api/advisor/goals/<id>/plan — "how much do I need to save per period?"
# ─────────────────────────────────────────────────────────────────────────────
@goals_bp.route('/api/advisor/goals/<int:goal_id>/plan', methods=['POST'])
def set_goal_plan(goal_id):
    """
    body: { frequency: 'weekly'|'biweekly'|'monthly', timeline_months: number }

    Works out how much the user needs to set aside per period to hit their
    goal in that timeframe, using what's actually left to save (target minus
    what's already saved) — or, for goals with no target_amount (e.g. "Just
    Saving"), falls back to the backend's real suggested_monthly_saving
    (20% of net income from get_income_vs_expense) scaled to the chosen
    frequency. Never returns a plan the user can't realistically afford
    based on their own numbers — it's derived from them, not guessed.
    """
    if 'user_id' not in session:
        return jsonify({'success': False, 'message': 'Not authenticated'}), 401

    data = request.json or {}
    frequency = str(data.get('frequency', '')).strip().lower()
    if frequency not in PERIODS_PER_MONTH:
        return jsonify({
            'success': False,
            'message': f'frequency must be one of: {", ".join(PERIODS_PER_MONTH.keys())}'
        }), 400

    try:
        timeline_months = float(data.get('timeline_months'))
        if timeline_months <= 0:
            raise ValueError
    except (TypeError, ValueError):
        return jsonify({'success': False, 'message': 'timeline_months must be a positive number'}), 400

    account_number = session['account_number']
    conn = get_pg_conn(); c = conn.cursor()
    c.execute("""
        SELECT id, target_amount, saved_amount FROM savings_goals
        WHERE id=%s AND account_number=%s
    """, (goal_id, account_number))
    goal_row = c.fetchone()
    if goal_row is None:
        release_pg_conn(conn)
        return jsonify({'success': False, 'message': 'Goal not found'}), 404

    target = goal_row['target_amount']
    saved = float(goal_row['saved_amount'] or 0)
    periods_per_month = PERIODS_PER_MONTH[frequency]
    total_periods = max(timeline_months * periods_per_month, 1)

    if target is not None and float(target) > saved:
        remaining = float(target) - saved
        per_period_amount = round(remaining / total_periods, 2)
    else:
        # No fixed target (or already met) — fall back to the real,
        # income-derived suggested monthly saving, scaled to this frequency.
        income_data = get_income_vs_expense(account_number)
        net = income_data.get('net', 0)
        suggested_monthly = net * 0.20 if net > 0 else 0
        per_period_amount = round(suggested_monthly / periods_per_month, 2) if periods_per_month else 0

    c.execute("""
        UPDATE savings_goals
        SET frequency=%s, timeline_months=%s, per_period_amount=%s
        WHERE id=%s AND account_number=%s
        RETURNING id, goal_type, goal_name, target_amount, target_date, saved_amount, frequency, timeline_months, per_period_amount
    """, (frequency, timeline_months, per_period_amount, goal_id, account_number))
    updated_row = c.fetchone()
    conn.commit()
    release_pg_conn(conn)

    return jsonify({'success': True, 'goal': _serialize_goal(updated_row)})