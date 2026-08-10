"""
investing_guide_routes.py — FinBud AI: "How do I actually invest in X" guides
==============================================================================

Exposes GET /api/advisor/investing/guide/<investment_type>, used by
InvestingPanel.jsx's "See full guide" flow. Purely educational — the guide
tells the user how they could go about investing outside the app; nothing
here executes a transaction or moves money.

Reuses generate_investment_guide() from advisor_chat.py, so there's a single
place (advisor_chat.py) owning the Groq client + prompt design for both the
chat bubble and these guides.
"""

from flask import Blueprint, jsonify, session
from advisor_chat import generate_investment_guide, INVESTMENT_TYPES

investing_guide_bp = Blueprint('investing_guide_bp', __name__)


@investing_guide_bp.route('/api/advisor/investing/guide/<investment_type>', methods=['GET'])
def get_investing_guide(investment_type):
    if 'user_id' not in session:
        return jsonify({'success': False, 'message': 'Not authenticated'}), 401

    if investment_type not in INVESTMENT_TYPES:
        return jsonify({'success': False, 'message': 'Unknown investment type'}), 400

    # NOTE: experience_level / risk_preference will come from the
    # advisor_profiles table (check-in feature) once merged — for now this
    # reads a session fallback, same placeholder pattern used in app.py's
    # financial_advisor chat branch. Swap for a real DB lookup when merging.
    user_context = {
        'experience_level': session.get('advisor_experience_level'),
        'risk_preference': session.get('advisor_risk_preference'),
    }

    guide_text = generate_investment_guide(investment_type, user_context)
    return jsonify({'success': True, 'investment_type': investment_type, 'guide': guide_text})


@investing_guide_bp.route('/api/advisor/investing/types', methods=['GET'])
def list_investment_types():
    """Returns the fixed list of investment types the frontend can show as cards."""
    if 'user_id' not in session:
        return jsonify({'success': False, 'message': 'Not authenticated'}), 401
    types = [{'value': k, 'label': v} for k, v in INVESTMENT_TYPES.items()]
    return jsonify({'success': True, 'types': types})