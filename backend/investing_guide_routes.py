"""
investing_guide_routes.py — FinBud AI: Investing Guide deterministic engine
==============================================================================

Replaces the old generic 2-question / Groq-generated guide flow with a
100% deterministic, rule-based matching engine driven by the 243-scenario
matrix in investing_scenarios_data.py. NOTHING in this file calls an LLM —
every response is built from hardcoded Python dictionaries, so results are
instant, reproducible, and identical to the source Excel sheet for any
given set of 5 answers.

Endpoints
---------
GET  /api/investing/questions        - the 5-question quiz (multilingual)
POST /api/investing/guide            - submit/re-submit the 5 answers, get
                                        the full recommendation + guide content
GET  /api/investing/guide            - fetch the saved profile's recommendation
                                        without re-answering (frontend calls
                                        this on load; 404 if not taken yet)
POST /api/investing/guide/retake     - clears the saved answers so the
                                        frontend can show the quiz again

Profile storage: delegated entirely to advisor_profile_routes.py
(get_investing_profile / save_investing_profile / clear_investing_profile),
which owns the advisor_profiles table — this file only owns the matching
logic and response shape, never touches the DB schema directly.
"""

import logging

from flask import Blueprint, request, jsonify, session

from advisor_profile_routes import (
    get_investing_profile,
    save_investing_profile,
    clear_investing_profile,
)
from investing_scenarios_data import (
    QUESTIONS,
    VALID_VALUES,
    ASSET_KEYS,
    ASSET_LABELS,
    GUIDE_CONTENT,
    get_recommendation,
    get_exclusion_reasons,
    get_scenario_advisories,
)

logger = logging.getLogger(__name__)

investing_guide_bp = Blueprint('investing_guide_bp', __name__)

SUPPORTED_LANGUAGES = ('en', 'ur_roman', 'ur')


# ─────────────────────────────────────────────────────────────────────────────
# Internal helpers
# ─────────────────────────────────────────────────────────────────────────────

def _validate_answers(data: dict):
    """
    Validates the 5 submitted answers against QUESTIONS/VALID_VALUES.
    Returns (answers_dict, None) on success, or (None, error_message) if
    anything is missing or not one of the 3 valid codes for its question.
    """
    answers = {}
    for question in QUESTIONS:
        qid = question['id']
        value = data.get(qid)
        if value not in VALID_VALUES[qid]:
            valid_list = ', '.join(sorted(VALID_VALUES[qid]))
            return None, f"'{qid}' must be one of: {valid_list}"
        answers[qid] = value
    return answers, None


def _build_asset_block(asset_key, answers, raw_score, suitability, rank, is_excluded):
    """
    Builds one asset's full response block: scores, rank badge, reasons
    (if excluded) or advisories (if included), and the multilingual guide
    content for that asset — everything the frontend's asset card + detail
    view needs in a single object, in all 3 languages at once so the
    language switcher on GuideDetailView never needs a re-fetch.
    """
    block = {
        'asset': asset_key,
        'label': ASSET_LABELS[asset_key],
        'rank': rank,                 # 1, 2, 3, or None if not top-3
        'excluded': is_excluded,
        'suitability_score': suitability,   # 0-100, for the gauge
        'raw_score': raw_score,
        'guide': GUIDE_CONTENT[asset_key],  # {en: {...}, ur_roman: {...}, ur: {...}}
    }

    if is_excluded:
        block['exclusion_reasons'] = get_exclusion_reasons(asset_key, answers)
        block['advisories'] = []
    else:
        block['exclusion_reasons'] = []
        block['advisories'] = get_scenario_advisories(asset_key, answers)

    return block


def _build_full_response(answers, updated_at):
    """Shared by POST and GET /api/investing/guide — builds the complete payload."""
    result = get_recommendation(**answers)
    top3, excluded = result['top3'], result['excluded']

    assets = {}
    for asset_key in ASSET_KEYS:
        raw = result['scores'][asset_key]['raw']
        suitability = result['scores'][asset_key]['suitability']
        rank = (top3.index(asset_key) + 1) if asset_key in top3 else None
        is_excluded = asset_key in excluded
        assets[asset_key] = _build_asset_block(asset_key, answers, raw, suitability, rank, is_excluded)

    return {
        'success': True,
        'answers': answers,
        'updated_at': updated_at,
        'top3': top3,
        'excluded': excluded,
        'assets': assets,
    }


# ─────────────────────────────────────────────────────────────────────────────
# GET /api/investing/questions
# ─────────────────────────────────────────────────────────────────────────────

@investing_guide_bp.route('/api/investing/questions', methods=['GET'])
def get_investing_questions():
    """Public shape of the 5-question quiz — frontend renders directly from this."""
    if 'user_id' not in session:
        return jsonify({'success': False, 'message': 'Not authenticated'}), 401

    return jsonify({'success': True, 'questions': QUESTIONS, 'languages': list(SUPPORTED_LANGUAGES)})


# ─────────────────────────────────────────────────────────────────────────────
# POST /api/investing/guide  — submit (or re-submit) the 5 answers
# ─────────────────────────────────────────────────────────────────────────────

@investing_guide_bp.route('/api/investing/guide', methods=['POST'])
def submit_investing_guide():
    if 'user_id' not in session:
        return jsonify({'success': False, 'message': 'Not authenticated'}), 401

    try:
        data = request.json or {}
        answers, error = _validate_answers(data)
        if error:
            return jsonify({'success': False, 'message': error}), 400

        account_number = session['account_number']
        save_investing_profile(
            account_number,
            experience=answers['experience'],
            risk=answers['risk'],
            horizon=answers['horizon'],
            goal=answers['goal'],
            amount=answers['amount'],
        )

        profile = get_investing_profile(account_number)
        response = _build_full_response(answers, profile['updated_at'] if profile else None)
        return jsonify(response)

    except Exception as e:
        logger.error(f"[submit_investing_guide] error: {e}")
        return jsonify({'success': False, 'message': str(e)}), 500


# ─────────────────────────────────────────────────────────────────────────────
# GET /api/investing/guide  — fetch saved profile's recommendation
# ─────────────────────────────────────────────────────────────────────────────

@investing_guide_bp.route('/api/investing/guide', methods=['GET'])
def get_investing_guide():
    if 'user_id' not in session:
        return jsonify({'success': False, 'message': 'Not authenticated'}), 401

    try:
        account_number = session['account_number']
        profile = get_investing_profile(account_number)

        if not profile:
            return jsonify({
                'success': False,
                'message': 'No saved assessment yet — submit POST /api/investing/guide first.',
                'has_profile': False,
            }), 404

        answers = {
            'experience': profile['experience'],
            'risk': profile['risk'],
            'horizon': profile['horizon'],
            'goal': profile['goal'],
            'amount': profile['amount'],
        }
        response = _build_full_response(answers, profile['updated_at'])
        response['has_profile'] = True
        return jsonify(response)

    except Exception as e:
        logger.error(f"[get_investing_guide] error: {e}")
        return jsonify({'success': False, 'message': str(e)}), 500


# ─────────────────────────────────────────────────────────────────────────────
# POST /api/investing/guide/retake  — clear saved answers
# ─────────────────────────────────────────────────────────────────────────────

@investing_guide_bp.route('/api/investing/guide/retake', methods=['POST'])
def retake_investing_guide():
    if 'user_id' not in session:
        return jsonify({'success': False, 'message': 'Not authenticated'}), 401

    try:
        clear_investing_profile(session['account_number'])
        return jsonify({'success': True, 'message': 'Assessment cleared — ready to retake.'})
    except Exception as e:
        logger.error(f"[retake_investing_guide] error: {e}")
        return jsonify({'success': False, 'message': str(e)}), 500


# ─────────────────────────────────────────────────────────────────────────────
# Back-compat: GET /api/advisor/investing/types
# Old frontend fallback list — kept so any cached/old client build doesn't
# hard-fail; the new InvestingPanel no longer calls this (it renders asset
# cards straight from /api/investing/guide's `assets` dict instead).
# ─────────────────────────────────────────────────────────────────────────────

@investing_guide_bp.route('/api/advisor/investing/types', methods=['GET'])
def list_investment_types():
    if 'user_id' not in session:
        return jsonify({'success': False, 'message': 'Not authenticated'}), 401
    types = [{'value': k, 'label': v['en']} for k, v in ASSET_LABELS.items()]
    return jsonify({'success': True, 'types': types})