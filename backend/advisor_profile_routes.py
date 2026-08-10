# advisor_profile_routes.py  –  FinBud AI: Risk Profile Check-in + Investing Suggestion
# ─────────────────────────────────────────────────────────────────────────────
# Scope: ONLY the risk-profile check-in and investing-suggestion feature.
# Does not touch any other route, table, or file.
#
# Reuses:
#   - get_pg_conn() / release_pg_conn() from features.py for all DB access
#     (RealDictCursor style — rows behave like dicts, row['col']).
#   - get_income_vs_expense(account) from features.py for income/expense
#     numbers — income/expense logic itself is NOT reimplemented here.
#   - The same Groq client construction pattern already used in
#     llm_falback.py (Groq(api_key=... or GROQ_API_KEY env var)). No new
#     provider or second API key is introduced.
# ─────────────────────────────────────────────────────────────────────────────

import os
import json
import logging
from datetime import datetime

from flask import Blueprint, request, jsonify, session

from features import get_pg_conn, release_pg_conn, get_income_vs_expense

# ── Optional: Groq client (same provider/pattern as llm_falback.py) ─────────
try:
    from groq import Groq
    GROQ_AVAILABLE = True
except ImportError:
    GROQ_AVAILABLE = False

logger = logging.getLogger(__name__)

advisor_profile_bp = Blueprint('advisor_profile_bp', __name__)

VALID_EXPERIENCE_LEVELS = {'never', 'a_little', 'comfortable'}
VALID_RISK_PREFERENCES  = {'safe', 'balanced', 'growth'}

# Hardcoded fallback — used whenever the Groq call fails or GROQ_API_KEY
# is missing, so this route can never 500 because of the LLM.
FALLBACK_CATEGORIES = [
    {
        "name": "Very safe, grows slowly",
        "description": "Like a savings account that barely moves — your money "
                        "stays safe and grows a little bit each year, with very "
                        "little chance of losing value."
    },
    {
        "name": "Some risk, grows faster over time",
        "description": "Like planting a tree — it takes patience and there are "
                        "ups and downs along the way, but given a few years it "
                        "tends to grow steadily bigger than cash sitting idle."
    },
    {
        "name": "Higher risk, higher potential growth",
        "description": "Like backing a small business — it could grow a lot "
                        "faster, but its value can also swing quickly, so only "
                        "put in what you're comfortable seeing go up and down."
    },
]


# ─────────────────────────────────────────────────────────────────────────────
# Schema
# ─────────────────────────────────────────────────────────────────────────────

def init_profile_tables(conn):
    """
    Creates the advisor_profiles table if it doesn't exist.

    Takes an already-open connection (called as
    init_profile_tables(get_pg_conn()) from app.py) and releases it back
    to the pool itself once done, so the caller doesn't leak a connection.
    """
    c = conn.cursor()
    c.execute('''
    CREATE TABLE IF NOT EXISTS advisor_profiles (
        account_number   TEXT PRIMARY KEY,
        experience_level TEXT NOT NULL,
        risk_preference  TEXT NOT NULL,
        created_at       TEXT NOT NULL
    )''')
    conn.commit()
    release_pg_conn(conn)


# ─────────────────────────────────────────────────────────────────────────────
# GET /api/advisor/profile
# ─────────────────────────────────────────────────────────────────────────────

@advisor_profile_bp.route('/api/advisor/profile', methods=['GET'])
def get_advisor_profile():
    if 'user_id' not in session:
        return jsonify({'success': False, 'message': 'Not authenticated'}), 401

    try:
        account_number = session['account_number']

        conn = get_pg_conn(); c = conn.cursor()
        c.execute("""
            SELECT account_number, experience_level, risk_preference, created_at
            FROM advisor_profiles
            WHERE account_number=%s
        """, (account_number,))
        row = c.fetchone()
        release_pg_conn(conn)

        profile = None
        if row:
            profile = {
                'account_number':   row['account_number'],
                'experience_level': row['experience_level'],
                'risk_preference':  row['risk_preference'],
                'created_at':       row['created_at']
            }

        return jsonify({'success': True, 'profile': profile})

    except Exception as e:
        logger.error(f"[get_advisor_profile] error: {e}")
        return jsonify({'success': False, 'message': str(e)}), 500


# ─────────────────────────────────────────────────────────────────────────────
# POST /api/advisor/profile  (upsert)
# ─────────────────────────────────────────────────────────────────────────────

@advisor_profile_bp.route('/api/advisor/profile', methods=['POST'])
def save_advisor_profile():
    if 'user_id' not in session:
        return jsonify({'success': False, 'message': 'Not authenticated'}), 401

    try:
        data              = request.json or {}
        experience_level  = str(data.get('experience_level', '')).strip()
        risk_preference   = str(data.get('risk_preference', '')).strip()

        if experience_level not in VALID_EXPERIENCE_LEVELS:
            return jsonify({
                'success': False,
                'message': f'experience_level must be one of: {", ".join(sorted(VALID_EXPERIENCE_LEVELS))}'
            }), 400

        if risk_preference not in VALID_RISK_PREFERENCES:
            return jsonify({
                'success': False,
                'message': f'risk_preference must be one of: {", ".join(sorted(VALID_RISK_PREFERENCES))}'
            }), 400

        account_number = session['account_number']
        now_iso         = datetime.utcnow().isoformat()

        conn = get_pg_conn(); c = conn.cursor()
        c.execute("""
            INSERT INTO advisor_profiles (account_number, experience_level, risk_preference, created_at)
            VALUES (%s, %s, %s, %s)
            ON CONFLICT (account_number) DO UPDATE SET
                experience_level = EXCLUDED.experience_level,
                risk_preference  = EXCLUDED.risk_preference
            RETURNING account_number, experience_level, risk_preference, created_at
        """, (account_number, experience_level, risk_preference, now_iso))
        row = c.fetchone()
        conn.commit()
        release_pg_conn(conn)

        return jsonify({
            'success': True,
            'profile': {
                'account_number':   row['account_number'],
                'experience_level': row['experience_level'],
                'risk_preference':  row['risk_preference'],
                'created_at':       row['created_at']
            }
        })

    except Exception as e:
        logger.error(f"[save_advisor_profile] error: {e}")
        return jsonify({'success': False, 'message': str(e)}), 500


# ─────────────────────────────────────────────────────────────────────────────
# GET /api/advisor/investing/suggestion
# ─────────────────────────────────────────────────────────────────────────────

def _generate_categories(experience_level: str):
    """
    Asks Groq for 3 plain-language, one-sentence risk category descriptions
    tailored to the user's experience level. Falls back to hardcoded
    descriptions if GROQ_API_KEY is missing or the call fails for any
    reason — this function must never raise.
    """
    if not GROQ_AVAILABLE or not os.environ.get("GROQ_API_KEY"):
        return FALLBACK_CATEGORIES

    try:
        client = Groq(api_key=os.environ.get("GROQ_API_KEY"))

        system_prompt = (
            "You are a financial literacy assistant for a Pakistani banking app. "
            "Explain investment risk categories in one plain, friendly sentence "
            "each, using real-world analogies. No jargon. Tailor tone to the "
            f"user's experience level: {experience_level}."
        )
        user_prompt = (
            "Write exactly one plain-language sentence for each of these 3 "
            "investment risk categories:\n"
            "1. Very safe, grows slowly\n"
            "2. Some risk, grows faster over time\n"
            "3. Higher risk, higher potential growth\n\n"
            "Return raw JSON only, no markdown, in this exact shape:\n"
            '{"safe": "...", "balanced": "...", "growth": "..."}'
        )

        response = client.chat.completions.create(
            model="llama-3.3-70b-versatile",
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user",   "content": user_prompt},
            ],
            temperature=0.4,
            max_tokens=300,
            response_format={"type": "json_object"},
        )

        raw    = response.choices[0].message.content
        parsed = json.loads(raw)

        safe_desc     = str(parsed.get('safe', '')).strip()
        balanced_desc = str(parsed.get('balanced', '')).strip()
        growth_desc   = str(parsed.get('growth', '')).strip()

        if safe_desc and balanced_desc and growth_desc:
            return [
                {"name": "Very safe, grows slowly", "description": safe_desc},
                {"name": "Some risk, grows faster over time", "description": balanced_desc},
                {"name": "Higher risk, higher potential growth", "description": growth_desc},
            ]

        logger.warning("Groq returned incomplete category descriptions, using fallback")
        return FALLBACK_CATEGORIES

    except Exception as exc:
        logger.warning(f"Groq category generation failed, using fallback: {exc}")
        return FALLBACK_CATEGORIES


@advisor_profile_bp.route('/api/advisor/investing/suggestion', methods=['GET'])
def investing_suggestion():
    if 'user_id' not in session:
        return jsonify({'success': False, 'message': 'Not authenticated'}), 401

    try:
        account_number = session['account_number']

        # Reuse existing income/expense logic — do NOT reimplement it here.
        income_data = get_income_vs_expense(account_number)
        net         = income_data.get('net', 0)

        recommended_monthly_amount = round(net * 0.10, 2) if net > 0 else 0

        # Look up experience_level (if the user has checked in) to tailor tone.
        experience_level = 'a_little'
        conn = get_pg_conn(); c = conn.cursor()
        c.execute(
            "SELECT experience_level FROM advisor_profiles WHERE account_number=%s",
            (account_number,)
        )
        row = c.fetchone()
        release_pg_conn(conn)
        if row and row.get('experience_level'):
            experience_level = row['experience_level']

        categories = _generate_categories(experience_level)

        return jsonify({
            'success':                    True,
            'recommended_monthly_amount': recommended_monthly_amount,
            'categories':                 categories,
            'disclaimer':                 'This is educational information, not formal financial advice.'
        })

    except Exception as e:
        logger.error(f"[investing_suggestion] error: {e}")
        return jsonify({'success': False, 'message': str(e)}), 500
