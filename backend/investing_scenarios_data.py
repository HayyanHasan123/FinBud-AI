"""
investing_scenarios_data.py — FinBud AI: deterministic investing-guide data
=============================================================================

Hardcoded data layer for the "Grow My Money" / Investing Guide module.
Everything here is a plain Python literal — NO LLM call is involved
anywhere in this file or in the request path that uses it. This is what
makes the matching engine 100% deterministic: the same 5 answers always
produce the exact same result, instantly, with no network dependency.

Contents
--------
1. QUESTIONS            — the 5-question onboarding quiz (multilingual)
2. ASSET_KEYS / LABELS   — the 6 asset categories
3. SCENARIO_TABLE        — all 243 rows from FinBud_Investing_Scenarios_All243.xlsx,
                           keyed by (experience, risk, horizon, goal, amount) code
                           tuples -> (stocks, mutual_funds, government_bonds, gold,
                           fixed_deposits, crypto) suitability scores.
                           Verified 1:1 against the source spreadsheet: the score
                           columns are the ground truth: -99 means the asset is
                           hard-excluded for that scenario; the Excel sheet's own
                           "#1/#2/#3 Recommended" and "Excluded" columns are simply
                           the top-3 (descending score) and the -99 entries — so
                           deriving them from these scores at request time is
                           mathematically identical to reading them from the sheet.
4. GUIDE_CONTENT          — hardcoded, structured, multilingual guide content per
                           asset (what it is, general how-to-start steps, how to
                           actually invest in Pakistan with named platforms, risk
                           note, minimum capital).
5. EXCLUSION_REASON_TEXT / ADVISORY_TEXT — hardcoded multilingual sentences used
                           by the rule functions below to explain *why* an asset
                           was excluded, or to add a caution for an included asset.
6. Rule functions         — get_scenario_scores(), get_recommendation(),
                           get_exclusion_reasons(), get_scenario_advisories(),
                           normalize_score() — pure Python, no I/O, no LLM.
"""

# ─────────────────────────────────────────────────────────────────────────────
# 1. Onboarding questionnaire — 5 questions, 3 options each.
#    `value` is the short code used as the SCENARIO_TABLE key component and in
#    API payloads. `excel_label` is the exact string from the source spreadsheet
#    (kept only for traceability / debugging — the API never requires it).
# ─────────────────────────────────────────────────────────────────────────────

QUESTIONS = [
    {
        'id': 'experience',
        'prompt': {
            'en': 'How much experience do you have with investing?',
            'ur_roman': 'Aapko investing ka kitna tajurba hai?',
            'ur': 'آپ کو سرمایہ کاری کا کتنا تجربہ ہے؟',
        },
        'options': [
            {'value': 'never', 'excel_label': 'Never invested',
             'label': {'en': 'Never invested', 'ur_roman': 'Kabhi invest nahi kiya', 'ur': 'کبھی سرمایہ کاری نہیں کی'}},
            {'value': 'a_little', 'excel_label': 'A little experience',
             'label': {'en': 'A little experience', 'ur_roman': 'Thora tajurba hai', 'ur': 'تھوڑا تجربہ ہے'}},
            {'value': 'comfortable', 'excel_label': 'Comfortable',
             'label': {'en': 'Comfortable', 'ur_roman': 'Comfortable hun', 'ur': 'باخبر / تجربہ کار'}},
        ],
    },
    {
        'id': 'risk',
        'prompt': {
            'en': 'How do you feel about risk?',
            'ur_roman': 'Risk ke baray mein aap kya sochte hain?',
            'ur': 'خطرے کے بارے میں آپ کیا سوچتے ہیں؟',
        },
        'options': [
            {'value': 'safe', 'excel_label': 'Keep it safe',
             'label': {'en': 'Keep it safe', 'ur_roman': 'Mehfooz rakhna hai', 'ur': 'محفوظ رکھنا ہے'}},
            {'value': 'balanced', 'excel_label': 'A little of both',
             'label': {'en': 'A little of both', 'ur_roman': 'Thora dono ka mix', 'ur': 'تھوڑا دونوں کا امتزاج'}},
            {'value': 'growth', 'excel_label': 'Open to growth',
             'label': {'en': 'Open to growth', 'ur_roman': 'Growth ke liye tayyar', 'ur': 'ترقی کے لیے تیار'}},
        ],
    },
    {
        'id': 'horizon',
        'prompt': {
            'en': 'When will you need this money?',
            'ur_roman': 'Aapko yeh paisa kab chahiye hoga?',
            'ur': 'آپ کو یہ رقم کب چاہیے ہوگی؟',
        },
        'options': [
            {'value': 'lt1', 'excel_label': '<1 year',
             'label': {'en': 'Less than 1 year', 'ur_roman': '1 saal se kam', 'ur': 'ایک سال سے کم'}},
            {'value': '1to3', 'excel_label': '1-3 years',
             'label': {'en': '1–3 years', 'ur_roman': '1-3 saal', 'ur': '1 سے 3 سال'}},
            {'value': '3plus', 'excel_label': '3+ years',
             'label': {'en': '3+ years', 'ur_roman': '3 saal ya zyada', 'ur': '3 سال یا زیادہ'}},
        ],
    },
    {
        'id': 'goal',
        'prompt': {
            'en': 'What is this money for?',
            'ur_roman': 'Yeh paisa kis maqsad ke liye hai?',
            'ur': 'یہ رقم کس مقصد کے لیے ہے؟',
        },
        'options': [
            {'value': 'emergency', 'excel_label': 'Emergency fund',
             'label': {'en': 'Emergency fund', 'ur_roman': 'Emergency fund', 'ur': 'ہنگامی فنڈ'}},
            {'value': 'specific', 'excel_label': 'Specific goal',
             'label': {'en': 'A specific goal', 'ur_roman': 'Koi khaas maqsad', 'ur': 'کوئی خاص مقصد'}},
            {'value': 'longterm', 'excel_label': 'Long-term wealth',
             'label': {'en': 'Long-term wealth', 'ur_roman': 'Long-term daulat banana', 'ur': 'طویل مدتی دولت'}},
        ],
    },
    {
        'id': 'amount',
        'prompt': {
            'en': 'How much can you invest each month?',
            'ur_roman': 'Aap har mahina kitna invest kar sakte hain?',
            'ur': 'آپ ہر ماہ کتنی سرمایہ کاری کر سکتے ہیں؟',
        },
        'options': [
            {'value': 'lt5k', 'excel_label': '<PKR 5k/mo',
             'label': {'en': 'Under PKR 5,000/mo', 'ur_roman': 'PKR 5,000/mahina se kam', 'ur': 'ماہانہ 5,000 روپے سے کم'}},
            {'value': '5to20k', 'excel_label': 'PKR 5k-20k/mo',
             'label': {'en': 'PKR 5,000–20,000/mo', 'ur_roman': 'PKR 5,000-20,000/mahina', 'ur': 'ماہانہ 5,000 سے 20,000 روپے'}},
            {'value': 'gt20k', 'excel_label': 'PKR 20k+/mo',
             'label': {'en': 'PKR 20,000+/mo', 'ur_roman': 'PKR 20,000+/mahina', 'ur': 'ماہانہ 20,000 روپے سے زیادہ'}},
        ],
    },
]

VALID_VALUES = {q['id']: {opt['value'] for opt in q['options']} for q in QUESTIONS}

# ─────────────────────────────────────────────────────────────────────────────
# 2. Asset categories — order here IS the score-tuple order in SCENARIO_TABLE.
# ─────────────────────────────────────────────────────────────────────────────

ASSET_KEYS = ['stocks', 'mutual_funds', 'government_bonds', 'gold', 'fixed_deposits', 'crypto']

ASSET_LABELS = {
    'stocks':           {'en': 'Stocks',              'ur_roman': 'Stocks',              'ur': 'اسٹاکس'},
    'mutual_funds':     {'en': 'Mutual Funds',        'ur_roman': 'Mutual Funds',        'ur': 'میوچل فنڈز'},
    'government_bonds': {'en': 'Govt Bonds / Sukuk',  'ur_roman': 'Govt Bonds / Sukuk',  'ur': 'گورنمنٹ بانڈز / صکوک'},
    'gold':             {'en': 'Gold',                'ur_roman': 'Sona',                'ur': 'سونا'},
    'fixed_deposits':   {'en': 'Fixed Deposits',      'ur_roman': 'Fixed Deposits',      'ur': 'فکسڈ ڈپازٹس'},
    'crypto':           {'en': 'Crypto',              'ur_roman': 'Crypto',              'ur': 'کرپٹو'},
}

# ─────────────────────────────────────────────────────────────────────────────
# 3. SCENARIO_TABLE — all 243 rows, generated 1:1 from
#    FinBud_Investing_Scenarios_All243.xlsx ("All 243 Scenarios" sheet).
#    Key:   (experience, risk, horizon, goal, amount) — all short codes above.
#    Value: (stocks, mutual_funds, government_bonds, gold, fixed_deposits, crypto)
#    -99 = hard-excluded for this scenario.
# ─────────────────────────────────────────────────────────────────────────────

SCENARIO_TABLE = {
    ('never', 'safe', 'lt1', 'emergency', 'lt5k'): (-99, -99, 4, 7, 7, -99),
    ('never', 'safe', 'lt1', 'emergency', '5to20k'): (-99, -99, 6, 6, 9, -99),
    ('never', 'safe', 'lt1', 'emergency', 'gt20k'): (-99, -99, 7, 5, 10, -99),
    ('never', 'safe', 'lt1', 'specific', 'lt5k'): (-99, 2, 4, 7, 6, -99),
    ('never', 'safe', 'lt1', 'specific', '5to20k'): (-99, 1, 6, 6, 8, -99),
    ('never', 'safe', 'lt1', 'specific', 'gt20k'): (-99, 0, 7, 5, 9, -99),
    ('never', 'safe', 'lt1', 'longterm', 'lt5k'): (-99, 3, 3, 7, 4, -99),
    ('never', 'safe', 'lt1', 'longterm', '5to20k'): (-99, 2, 5, 6, 6, -99),
    ('never', 'safe', 'lt1', 'longterm', 'gt20k'): (-99, 1, 6, 5, 7, -99),
    ('never', 'safe', '1to3', 'emergency', 'lt5k'): (-99, -99, 5, 7, 6, -99),
    ('never', 'safe', '1to3', 'emergency', '5to20k'): (-99, -99, 7, 6, 8, -99),
    ('never', 'safe', '1to3', 'emergency', 'gt20k'): (-99, -99, 8, 5, 9, -99),
    ('never', 'safe', '1to3', 'specific', 'lt5k'): (-99, 4, 5, 7, 5, -99),
    ('never', 'safe', '1to3', 'specific', '5to20k'): (-99, 3, 7, 6, 7, -99),
    ('never', 'safe', '1to3', 'specific', 'gt20k'): (-99, 2, 8, 5, 8, -99),
    ('never', 'safe', '1to3', 'longterm', 'lt5k'): (-99, 5, 4, 7, 3, -99),
    ('never', 'safe', '1to3', 'longterm', '5to20k'): (-99, 4, 6, 6, 5, -99),
    ('never', 'safe', '1to3', 'longterm', 'gt20k'): (-99, 3, 7, 5, 6, -99),
    ('never', 'safe', '3plus', 'emergency', 'lt5k'): (-99, -99, 3, 7, 4, -99),
    ('never', 'safe', '3plus', 'emergency', '5to20k'): (-99, -99, 5, 6, 6, -99),
    ('never', 'safe', '3plus', 'emergency', 'gt20k'): (-99, -99, 6, 5, 7, -99),
    ('never', 'safe', '3plus', 'specific', 'lt5k'): (-99, 5, 3, 7, 3, -99),
    ('never', 'safe', '3plus', 'specific', '5to20k'): (-99, 4, 5, 6, 5, -99),
    ('never', 'safe', '3plus', 'specific', 'gt20k'): (-99, 3, 6, 5, 6, -99),
    ('never', 'safe', '3plus', 'longterm', 'lt5k'): (-99, 6, 2, 7, 1, -99),
    ('never', 'safe', '3plus', 'longterm', '5to20k'): (-99, 5, 4, 6, 3, -99),
    ('never', 'safe', '3plus', 'longterm', 'gt20k'): (-99, 4, 5, 5, 4, -99),
    ('never', 'balanced', 'lt1', 'emergency', 'lt5k'): (-99, -99, 3, 6, 6, -99),
    ('never', 'balanced', 'lt1', 'emergency', '5to20k'): (-99, -99, 5, 5, 8, -99),
    ('never', 'balanced', 'lt1', 'emergency', 'gt20k'): (-99, -99, 6, 4, 9, -99),
    ('never', 'balanced', 'lt1', 'specific', 'lt5k'): (-99, 4, 3, 6, 5, -99),
    ('never', 'balanced', 'lt1', 'specific', '5to20k'): (-99, 3, 5, 5, 7, -99),
    ('never', 'balanced', 'lt1', 'specific', 'gt20k'): (-99, 2, 6, 4, 8, -99),
    ('never', 'balanced', 'lt1', 'longterm', 'lt5k'): (-99, 5, 2, 6, 3, -99),
    ('never', 'balanced', 'lt1', 'longterm', '5to20k'): (-99, 4, 4, 5, 5, -99),
    ('never', 'balanced', 'lt1', 'longterm', 'gt20k'): (-99, 3, 5, 4, 6, -99),
    ('never', 'balanced', '1to3', 'emergency', 'lt5k'): (-99, -99, 4, 6, 5, -99),
    ('never', 'balanced', '1to3', 'emergency', '5to20k'): (-99, -99, 6, 5, 7, -99),
    ('never', 'balanced', '1to3', 'emergency', 'gt20k'): (-99, -99, 7, 4, 8, -99),
    ('never', 'balanced', '1to3', 'specific', 'lt5k'): (-99, 6, 4, 6, 4, -99),
    ('never', 'balanced', '1to3', 'specific', '5to20k'): (-99, 5, 6, 5, 6, -99),
    ('never', 'balanced', '1to3', 'specific', 'gt20k'): (-99, 4, 7, 4, 7, -99),
    ('never', 'balanced', '1to3', 'longterm', 'lt5k'): (-99, 7, 3, 6, 2, -99),
    ('never', 'balanced', '1to3', 'longterm', '5to20k'): (-99, 6, 5, 5, 4, -99),
    ('never', 'balanced', '1to3', 'longterm', 'gt20k'): (-99, 5, 6, 4, 5, -99),
    ('never', 'balanced', '3plus', 'emergency', 'lt5k'): (-99, -99, 2, 6, 3, -99),
    ('never', 'balanced', '3plus', 'emergency', '5to20k'): (-99, -99, 4, 5, 5, -99),
    ('never', 'balanced', '3plus', 'emergency', 'gt20k'): (-99, -99, 5, 4, 6, -99),
    ('never', 'balanced', '3plus', 'specific', 'lt5k'): (-99, 7, 2, 6, 2, -99),
    ('never', 'balanced', '3plus', 'specific', '5to20k'): (-99, 6, 4, 5, 4, -99),
    ('never', 'balanced', '3plus', 'specific', 'gt20k'): (-99, 5, 5, 4, 5, -99),
    ('never', 'balanced', '3plus', 'longterm', 'lt5k'): (-99, 8, 1, 6, 0, -99),
    ('never', 'balanced', '3plus', 'longterm', '5to20k'): (-99, 7, 3, 5, 2, -99),
    ('never', 'balanced', '3plus', 'longterm', 'gt20k'): (-99, 6, 4, 4, 3, -99),
    ('never', 'growth', 'lt1', 'emergency', 'lt5k'): (-99, -99, 1, 5, 4, -99),
    ('never', 'growth', 'lt1', 'emergency', '5to20k'): (-99, -99, 3, 4, 6, -99),
    ('never', 'growth', 'lt1', 'emergency', 'gt20k'): (-99, -99, 4, 3, 7, -99),
    ('never', 'growth', 'lt1', 'specific', 'lt5k'): (-99, 4, 1, 5, 3, -99),
    ('never', 'growth', 'lt1', 'specific', '5to20k'): (-99, 3, 3, 4, 5, -99),
    ('never', 'growth', 'lt1', 'specific', 'gt20k'): (-99, 2, 4, 3, 6, -99),
    ('never', 'growth', 'lt1', 'longterm', 'lt5k'): (-99, 5, 0, 5, 1, -99),
    ('never', 'growth', 'lt1', 'longterm', '5to20k'): (-99, 4, 2, 4, 3, -99),
    ('never', 'growth', 'lt1', 'longterm', 'gt20k'): (-99, 3, 3, 3, 4, -99),
    ('never', 'growth', '1to3', 'emergency', 'lt5k'): (-99, -99, 2, 5, 3, -99),
    ('never', 'growth', '1to3', 'emergency', '5to20k'): (-99, -99, 4, 4, 5, -99),
    ('never', 'growth', '1to3', 'emergency', 'gt20k'): (-99, -99, 5, 3, 6, -99),
    ('never', 'growth', '1to3', 'specific', 'lt5k'): (-99, 6, 2, 5, 2, -99),
    ('never', 'growth', '1to3', 'specific', '5to20k'): (-99, 5, 4, 4, 4, -99),
    ('never', 'growth', '1to3', 'specific', 'gt20k'): (-99, 4, 5, 3, 5, -99),
    ('never', 'growth', '1to3', 'longterm', 'lt5k'): (-99, 7, 1, 5, 0, -99),
    ('never', 'growth', '1to3', 'longterm', '5to20k'): (-99, 6, 3, 4, 2, -99),
    ('never', 'growth', '1to3', 'longterm', 'gt20k'): (-99, 5, 4, 3, 3, -99),
    ('never', 'growth', '3plus', 'emergency', 'lt5k'): (-99, -99, 0, 5, 1, -99),
    ('never', 'growth', '3plus', 'emergency', '5to20k'): (-99, -99, 2, 4, 3, -99),
    ('never', 'growth', '3plus', 'emergency', 'gt20k'): (-99, -99, 3, 3, 4, -99),
    ('never', 'growth', '3plus', 'specific', 'lt5k'): (-99, 7, 0, 5, 0, -99),
    ('never', 'growth', '3plus', 'specific', '5to20k'): (-99, 6, 2, 4, 2, -99),
    ('never', 'growth', '3plus', 'specific', 'gt20k'): (-99, 5, 3, 3, 3, -99),
    ('never', 'growth', '3plus', 'longterm', 'lt5k'): (-99, 8, -1, 5, -2, -99),
    ('never', 'growth', '3plus', 'longterm', '5to20k'): (-99, 7, 1, 4, 0, -99),
    ('never', 'growth', '3plus', 'longterm', 'gt20k'): (-99, 6, 2, 3, 1, -99),
    ('a_little', 'safe', 'lt1', 'emergency', 'lt5k'): (-99, -99, 4, 7, 6, -99),
    ('a_little', 'safe', 'lt1', 'emergency', '5to20k'): (-99, -99, 6, 6, 8, -99),
    ('a_little', 'safe', 'lt1', 'emergency', 'gt20k'): (-99, -99, 7, 5, 9, -99),
    ('a_little', 'safe', 'lt1', 'specific', 'lt5k'): (-99, 3, 4, 7, 5, -99),
    ('a_little', 'safe', 'lt1', 'specific', '5to20k'): (-99, 2, 6, 6, 7, -99),
    ('a_little', 'safe', 'lt1', 'specific', 'gt20k'): (-99, 1, 7, 5, 8, -99),
    ('a_little', 'safe', 'lt1', 'longterm', 'lt5k'): (-99, 4, 3, 7, 3, -99),
    ('a_little', 'safe', 'lt1', 'longterm', '5to20k'): (-99, 3, 5, 6, 5, -99),
    ('a_little', 'safe', 'lt1', 'longterm', 'gt20k'): (-99, 2, 6, 5, 6, -99),
    ('a_little', 'safe', '1to3', 'emergency', 'lt5k'): (-99, -99, 5, 7, 5, -99),
    ('a_little', 'safe', '1to3', 'emergency', '5to20k'): (-99, -99, 7, 6, 7, -99),
    ('a_little', 'safe', '1to3', 'emergency', 'gt20k'): (-99, -99, 8, 5, 8, -99),
    ('a_little', 'safe', '1to3', 'specific', 'lt5k'): (-5, 5, 5, 7, 4, -99),
    ('a_little', 'safe', '1to3', 'specific', '5to20k'): (-5, 4, 7, 6, 6, -99),
    ('a_little', 'safe', '1to3', 'specific', 'gt20k'): (-5, 3, 8, 5, 7, -99),
    ('a_little', 'safe', '1to3', 'longterm', 'lt5k'): (-3, 6, 4, 7, 2, -99),
    ('a_little', 'safe', '1to3', 'longterm', '5to20k'): (-3, 5, 6, 6, 4, -99),
    ('a_little', 'safe', '1to3', 'longterm', 'gt20k'): (-3, 4, 7, 5, 5, -99),
    ('a_little', 'safe', '3plus', 'emergency', 'lt5k'): (-99, -99, 3, 7, 3, -99),
    ('a_little', 'safe', '3plus', 'emergency', '5to20k'): (-99, -99, 5, 6, 5, -99),
    ('a_little', 'safe', '3plus', 'emergency', 'gt20k'): (-99, -99, 6, 5, 6, -99),
    ('a_little', 'safe', '3plus', 'specific', 'lt5k'): (-2, 6, 3, 7, 2, -99),
    ('a_little', 'safe', '3plus', 'specific', '5to20k'): (-2, 5, 5, 6, 4, -99),
    ('a_little', 'safe', '3plus', 'specific', 'gt20k'): (-2, 4, 6, 5, 5, -99),
    ('a_little', 'safe', '3plus', 'longterm', 'lt5k'): (0, 7, 2, 7, 0, -99),
    ('a_little', 'safe', '3plus', 'longterm', '5to20k'): (0, 6, 4, 6, 2, -99),
    ('a_little', 'safe', '3plus', 'longterm', 'gt20k'): (0, 5, 5, 5, 3, -99),
    ('a_little', 'balanced', 'lt1', 'emergency', 'lt5k'): (-99, -99, 3, 6, 5, -99),
    ('a_little', 'balanced', 'lt1', 'emergency', '5to20k'): (-99, -99, 5, 5, 7, -99),
    ('a_little', 'balanced', 'lt1', 'emergency', 'gt20k'): (-99, -99, 6, 4, 8, -99),
    ('a_little', 'balanced', 'lt1', 'specific', 'lt5k'): (-99, 5, 3, 6, 4, -99),
    ('a_little', 'balanced', 'lt1', 'specific', '5to20k'): (-99, 4, 5, 5, 6, -99),
    ('a_little', 'balanced', 'lt1', 'specific', 'gt20k'): (-99, 3, 6, 4, 7, -99),
    ('a_little', 'balanced', 'lt1', 'longterm', 'lt5k'): (-99, 6, 2, 6, 2, -99),
    ('a_little', 'balanced', 'lt1', 'longterm', '5to20k'): (-99, 5, 4, 5, 4, -99),
    ('a_little', 'balanced', 'lt1', 'longterm', 'gt20k'): (-99, 4, 5, 4, 5, -99),
    ('a_little', 'balanced', '1to3', 'emergency', 'lt5k'): (-99, -99, 4, 6, 4, -99),
    ('a_little', 'balanced', '1to3', 'emergency', '5to20k'): (-99, -99, 6, 5, 6, -99),
    ('a_little', 'balanced', '1to3', 'emergency', 'gt20k'): (-99, -99, 7, 4, 7, -99),
    ('a_little', 'balanced', '1to3', 'specific', 'lt5k'): (-2, 7, 4, 6, 3, -99),
    ('a_little', 'balanced', '1to3', 'specific', '5to20k'): (-2, 6, 6, 5, 5, -99),
    ('a_little', 'balanced', '1to3', 'specific', 'gt20k'): (-2, 5, 7, 4, 6, -99),
    ('a_little', 'balanced', '1to3', 'longterm', 'lt5k'): (0, 8, 3, 6, 1, -99),
    ('a_little', 'balanced', '1to3', 'longterm', '5to20k'): (0, 7, 5, 5, 3, -99),
    ('a_little', 'balanced', '1to3', 'longterm', 'gt20k'): (0, 6, 6, 4, 4, -99),
    ('a_little', 'balanced', '3plus', 'emergency', 'lt5k'): (-99, -99, 2, 6, 2, -99),
    ('a_little', 'balanced', '3plus', 'emergency', '5to20k'): (-99, -99, 4, 5, 4, -99),
    ('a_little', 'balanced', '3plus', 'emergency', 'gt20k'): (-99, -99, 5, 4, 5, -99),
    ('a_little', 'balanced', '3plus', 'specific', 'lt5k'): (1, 8, 2, 6, 1, -99),
    ('a_little', 'balanced', '3plus', 'specific', '5to20k'): (1, 7, 4, 5, 3, -99),
    ('a_little', 'balanced', '3plus', 'specific', 'gt20k'): (1, 6, 5, 4, 4, -99),
    ('a_little', 'balanced', '3plus', 'longterm', 'lt5k'): (3, 9, 1, 6, -1, -99),
    ('a_little', 'balanced', '3plus', 'longterm', '5to20k'): (3, 8, 3, 5, 1, -99),
    ('a_little', 'balanced', '3plus', 'longterm', 'gt20k'): (3, 7, 4, 4, 2, -99),
    ('a_little', 'growth', 'lt1', 'emergency', 'lt5k'): (-99, -99, 1, 5, 3, -99),
    ('a_little', 'growth', 'lt1', 'emergency', '5to20k'): (-99, -99, 3, 4, 5, -99),
    ('a_little', 'growth', 'lt1', 'emergency', 'gt20k'): (-99, -99, 4, 3, 6, -99),
    ('a_little', 'growth', 'lt1', 'specific', 'lt5k'): (-99, 5, 1, 5, 2, -99),
    ('a_little', 'growth', 'lt1', 'specific', '5to20k'): (-99, 4, 3, 4, 4, -99),
    ('a_little', 'growth', 'lt1', 'specific', 'gt20k'): (-99, 3, 4, 3, 5, -99),
    ('a_little', 'growth', 'lt1', 'longterm', 'lt5k'): (-99, 6, 0, 5, 0, -99),
    ('a_little', 'growth', 'lt1', 'longterm', '5to20k'): (-99, 5, 2, 4, 2, -99),
    ('a_little', 'growth', 'lt1', 'longterm', 'gt20k'): (-99, 4, 3, 3, 3, -99),
    ('a_little', 'growth', '1to3', 'emergency', 'lt5k'): (-99, -99, 2, 5, 2, -99),
    ('a_little', 'growth', '1to3', 'emergency', '5to20k'): (-99, -99, 4, 4, 4, -99),
    ('a_little', 'growth', '1to3', 'emergency', 'gt20k'): (-99, -99, 5, 3, 5, -99),
    ('a_little', 'growth', '1to3', 'specific', 'lt5k'): (0, 7, 2, 5, 1, -99),
    ('a_little', 'growth', '1to3', 'specific', '5to20k'): (0, 6, 4, 4, 3, -99),
    ('a_little', 'growth', '1to3', 'specific', 'gt20k'): (0, 5, 5, 3, 4, -99),
    ('a_little', 'growth', '1to3', 'longterm', 'lt5k'): (2, 8, 1, 5, -1, -99),
    ('a_little', 'growth', '1to3', 'longterm', '5to20k'): (2, 7, 3, 4, 1, -99),
    ('a_little', 'growth', '1to3', 'longterm', 'gt20k'): (2, 6, 4, 3, 2, -99),
    ('a_little', 'growth', '3plus', 'emergency', 'lt5k'): (-99, -99, 0, 5, 0, -99),
    ('a_little', 'growth', '3plus', 'emergency', '5to20k'): (-99, -99, 2, 4, 2, -99),
    ('a_little', 'growth', '3plus', 'emergency', 'gt20k'): (-99, -99, 3, 3, 3, -99),
    ('a_little', 'growth', '3plus', 'specific', 'lt5k'): (3, 8, 0, 5, -1, -99),
    ('a_little', 'growth', '3plus', 'specific', '5to20k'): (3, 7, 2, 4, 1, -99),
    ('a_little', 'growth', '3plus', 'specific', 'gt20k'): (3, 6, 3, 3, 2, -99),
    ('a_little', 'growth', '3plus', 'longterm', 'lt5k'): (5, 9, -1, 5, -3, -99),
    ('a_little', 'growth', '3plus', 'longterm', '5to20k'): (5, 8, 1, 4, -1, -99),
    ('a_little', 'growth', '3plus', 'longterm', 'gt20k'): (5, 7, 2, 3, 0, -99),
    ('comfortable', 'safe', 'lt1', 'emergency', 'lt5k'): (-99, -99, 3, 6, 5, -99),
    ('comfortable', 'safe', 'lt1', 'emergency', '5to20k'): (-99, -99, 5, 5, 7, -99),
    ('comfortable', 'safe', 'lt1', 'emergency', 'gt20k'): (-99, -99, 6, 4, 8, -99),
    ('comfortable', 'safe', 'lt1', 'specific', 'lt5k'): (-99, 3, 3, 6, 4, -99),
    ('comfortable', 'safe', 'lt1', 'specific', '5to20k'): (-99, 2, 5, 5, 6, -99),
    ('comfortable', 'safe', 'lt1', 'specific', 'gt20k'): (-99, 1, 6, 4, 7, -99),
    ('comfortable', 'safe', 'lt1', 'longterm', 'lt5k'): (-99, 4, 2, 6, 2, -99),
    ('comfortable', 'safe', 'lt1', 'longterm', '5to20k'): (-99, 3, 4, 5, 4, -99),
    ('comfortable', 'safe', 'lt1', 'longterm', 'gt20k'): (-99, 2, 5, 4, 5, -99),
    ('comfortable', 'safe', '1to3', 'emergency', 'lt5k'): (-99, -99, 4, 6, 4, -99),
    ('comfortable', 'safe', '1to3', 'emergency', '5to20k'): (-99, -99, 6, 5, 6, -99),
    ('comfortable', 'safe', '1to3', 'emergency', 'gt20k'): (-99, -99, 7, 4, 7, -99),
    ('comfortable', 'safe', '1to3', 'specific', 'lt5k'): (-3, 5, 4, 6, 3, -99),
    ('comfortable', 'safe', '1to3', 'specific', '5to20k'): (-3, 4, 6, 5, 5, -99),
    ('comfortable', 'safe', '1to3', 'specific', 'gt20k'): (-3, 3, 7, 4, 6, -99),
    ('comfortable', 'safe', '1to3', 'longterm', 'lt5k'): (-1, 6, 3, 6, 1, -99),
    ('comfortable', 'safe', '1to3', 'longterm', '5to20k'): (-1, 5, 5, 5, 3, -99),
    ('comfortable', 'safe', '1to3', 'longterm', 'gt20k'): (-1, 4, 6, 4, 4, -99),
    ('comfortable', 'safe', '3plus', 'emergency', 'lt5k'): (-99, -99, 2, 6, 2, -99),
    ('comfortable', 'safe', '3plus', 'emergency', '5to20k'): (-99, -99, 4, 5, 4, -99),
    ('comfortable', 'safe', '3plus', 'emergency', 'gt20k'): (-99, -99, 5, 4, 5, -99),
    ('comfortable', 'safe', '3plus', 'specific', 'lt5k'): (0, 6, 2, 6, 1, -99),
    ('comfortable', 'safe', '3plus', 'specific', '5to20k'): (0, 5, 4, 5, 3, -99),
    ('comfortable', 'safe', '3plus', 'specific', 'gt20k'): (0, 4, 5, 4, 4, -99),
    ('comfortable', 'safe', '3plus', 'longterm', 'lt5k'): (2, 7, 1, 6, -1, -99),
    ('comfortable', 'safe', '3plus', 'longterm', '5to20k'): (2, 6, 3, 5, 1, -99),
    ('comfortable', 'safe', '3plus', 'longterm', 'gt20k'): (2, 5, 4, 4, 2, -99),
    ('comfortable', 'balanced', 'lt1', 'emergency', 'lt5k'): (-99, -99, 2, 5, 4, -99),
    ('comfortable', 'balanced', 'lt1', 'emergency', '5to20k'): (-99, -99, 4, 4, 6, -99),
    ('comfortable', 'balanced', 'lt1', 'emergency', 'gt20k'): (-99, -99, 5, 3, 7, -99),
    ('comfortable', 'balanced', 'lt1', 'specific', 'lt5k'): (-99, 5, 2, 5, 3, -99),
    ('comfortable', 'balanced', 'lt1', 'specific', '5to20k'): (-99, 4, 4, 4, 5, -99),
    ('comfortable', 'balanced', 'lt1', 'specific', 'gt20k'): (-99, 3, 5, 3, 6, -99),
    ('comfortable', 'balanced', 'lt1', 'longterm', 'lt5k'): (-99, 6, 1, 5, 1, -99),
    ('comfortable', 'balanced', 'lt1', 'longterm', '5to20k'): (-99, 5, 3, 4, 3, -99),
    ('comfortable', 'balanced', 'lt1', 'longterm', 'gt20k'): (-99, 4, 4, 3, 4, -99),
    ('comfortable', 'balanced', '1to3', 'emergency', 'lt5k'): (-99, -99, 3, 5, 3, -99),
    ('comfortable', 'balanced', '1to3', 'emergency', '5to20k'): (-99, -99, 5, 4, 5, -99),
    ('comfortable', 'balanced', '1to3', 'emergency', 'gt20k'): (-99, -99, 6, 3, 6, -99),
    ('comfortable', 'balanced', '1to3', 'specific', 'lt5k'): (0, 7, 3, 5, 2, -99),
    ('comfortable', 'balanced', '1to3', 'specific', '5to20k'): (0, 6, 5, 4, 4, -99),
    ('comfortable', 'balanced', '1to3', 'specific', 'gt20k'): (0, 5, 6, 3, 5, -99),
    ('comfortable', 'balanced', '1to3', 'longterm', 'lt5k'): (2, 8, 2, 5, 0, -99),
    ('comfortable', 'balanced', '1to3', 'longterm', '5to20k'): (2, 7, 4, 4, 2, -99),
    ('comfortable', 'balanced', '1to3', 'longterm', 'gt20k'): (2, 6, 5, 3, 3, -99),
    ('comfortable', 'balanced', '3plus', 'emergency', 'lt5k'): (-99, -99, 1, 5, 1, -99),
    ('comfortable', 'balanced', '3plus', 'emergency', '5to20k'): (-99, -99, 3, 4, 3, -99),
    ('comfortable', 'balanced', '3plus', 'emergency', 'gt20k'): (-99, -99, 4, 3, 4, -99),
    ('comfortable', 'balanced', '3plus', 'specific', 'lt5k'): (3, 8, 1, 5, 0, -99),
    ('comfortable', 'balanced', '3plus', 'specific', '5to20k'): (3, 7, 3, 4, 2, -99),
    ('comfortable', 'balanced', '3plus', 'specific', 'gt20k'): (3, 6, 4, 3, 3, -99),
    ('comfortable', 'balanced', '3plus', 'longterm', 'lt5k'): (5, 9, 0, 5, -2, -99),
    ('comfortable', 'balanced', '3plus', 'longterm', '5to20k'): (5, 8, 2, 4, 0, -99),
    ('comfortable', 'balanced', '3plus', 'longterm', 'gt20k'): (5, 7, 3, 3, 1, -99),
    ('comfortable', 'growth', 'lt1', 'emergency', 'lt5k'): (-99, -99, 0, 4, 2, -99),
    ('comfortable', 'growth', 'lt1', 'emergency', '5to20k'): (-99, -99, 2, 3, 4, -99),
    ('comfortable', 'growth', 'lt1', 'emergency', 'gt20k'): (-99, -99, 3, 2, 5, -99),
    ('comfortable', 'growth', 'lt1', 'specific', 'lt5k'): (-99, 5, 0, 4, 1, -99),
    ('comfortable', 'growth', 'lt1', 'specific', '5to20k'): (-99, 4, 2, 3, 3, -99),
    ('comfortable', 'growth', 'lt1', 'specific', 'gt20k'): (-99, 3, 3, 2, 4, -99),
    ('comfortable', 'growth', 'lt1', 'longterm', 'lt5k'): (-99, 6, -1, 4, -1, -99),
    ('comfortable', 'growth', 'lt1', 'longterm', '5to20k'): (-99, 5, 1, 3, 1, -99),
    ('comfortable', 'growth', 'lt1', 'longterm', 'gt20k'): (-99, 4, 2, 2, 2, -99),
    ('comfortable', 'growth', '1to3', 'emergency', 'lt5k'): (-99, -99, 1, 4, 1, -99),
    ('comfortable', 'growth', '1to3', 'emergency', '5to20k'): (-99, -99, 3, 3, 3, -99),
    ('comfortable', 'growth', '1to3', 'emergency', 'gt20k'): (-99, -99, 4, 2, 4, -99),
    ('comfortable', 'growth', '1to3', 'specific', 'lt5k'): (2, 7, 1, 4, 0, -2),
    ('comfortable', 'growth', '1to3', 'specific', '5to20k'): (2, 6, 3, 3, 2, -2),
    ('comfortable', 'growth', '1to3', 'specific', 'gt20k'): (2, 5, 4, 2, 3, -2),
    ('comfortable', 'growth', '1to3', 'longterm', 'lt5k'): (4, 8, 0, 4, -2, 0),
    ('comfortable', 'growth', '1to3', 'longterm', '5to20k'): (4, 7, 2, 3, 0, 0),
    ('comfortable', 'growth', '1to3', 'longterm', 'gt20k'): (4, 6, 3, 2, 1, 0),
    ('comfortable', 'growth', '3plus', 'emergency', 'lt5k'): (-99, -99, -1, 4, -1, -99),
    ('comfortable', 'growth', '3plus', 'emergency', '5to20k'): (-99, -99, 1, 3, 1, -99),
    ('comfortable', 'growth', '3plus', 'emergency', 'gt20k'): (-99, -99, 2, 2, 2, -99),
    ('comfortable', 'growth', '3plus', 'specific', 'lt5k'): (5, 8, -1, 4, -2, 0),
    ('comfortable', 'growth', '3plus', 'specific', '5to20k'): (5, 7, 1, 3, 0, 0),
    ('comfortable', 'growth', '3plus', 'specific', 'gt20k'): (5, 6, 2, 2, 1, 0),
    ('comfortable', 'growth', '3plus', 'longterm', 'lt5k'): (7, 9, -2, 4, -4, 2),
    ('comfortable', 'growth', '3plus', 'longterm', '5to20k'): (7, 8, 0, 3, -2, 2),
    ('comfortable', 'growth', '3plus', 'longterm', 'gt20k'): (7, 7, 1, 2, -1, 2),
}


# ─────────────────────────────────────────────────────────────────────────────
# 4. GUIDE_CONTENT — hardcoded, structured, multilingual guide content.
# ─────────────────────────────────────────────────────────────────────────────

GUIDE_CONTENT = {   'stocks': {   'en': {   'what_is_it': "When you buy a stock, you're buying a small piece of a real "
                                          'company. If the company does well, your piece becomes worth more '
                                          '— and some companies also pay you a little extra cash now and '
                                          'then, just for holding on to it.',
                            'general_steps': [   "Get your CNIC ready — you'll need it to prove who you are",
                                                 'Choose a bank or investment app that lets you buy stocks '
                                                 '(several big banks and apps in Pakistan offer this)',
                                                 'Fill out a simple form with your basic details and CNIC to '
                                                 'open the account — approval usually takes a day or two',
                                                 'Transfer some money from your regular bank account into '
                                                 'this new investment account',
                                                 'Look through a list of companies, pick one or two '
                                                 'well-known ones to start with, and place your first buy '
                                                 'order — the app will walk you through it step by step',
                                                 "Check in on your app every so often to see how it's doing "
                                                 "— you don't need to check it every day"],
                            'risk': {   'level': 'Medium-High',
                                        'note': 'This means the value of your money can go up and down quite '
                                                'a bit — sometimes even within the same week. If the company '
                                                'does well, you could earn good money; if it struggles, you '
                                                "could lose some of what you put in. It's best used for "
                                                "money you won't need for at least a few years, so you have "
                                                'time to ride out the ups and downs.'},
                            'min_capital': 'You can start with as little as PKR 5,000–10,000',
                            'how_to_invest_pk': [   'Open a brokerage account with a PSX (Pakistan Stock '
                                                    'Exchange) registered broker — e.g. AKD Securities, JS '
                                                    'Global, or any TREC-holder broker listed on psx.com.pk',
                                                    'The broker opens a CDC (Central Depository Company) '
                                                    'sub-account in your name — this is where your shares '
                                                    'are legally held',
                                                    'Complete KYC with your CNIC and a bank account for fund '
                                                    'transfers (most brokers now do this fully online)',
                                                    'Fund your trading account, then place your first buy '
                                                    "order through the broker's app or web platform (e.g. "
                                                    'SCSTrade, JS Bank Go, AKD Trade)',
                                                    'Overseas Pakistanis can invest via a Roshan Digital '
                                                    'Account (RDA), which comes with a linked PSX trading '
                                                    'and CDC account']},
                  'ur_roman': {   'what_is_it': 'Jab aap stock khareedte hain, to aap kisi asli company ka '
                                                'aik chhota hissa khareed rahe hote hain. Agar company acha '
                                                'perform kare, to aapka hissa ziada qeemti ho jata hai — aur '
                                                'kuch companies sirf shares rakhne par bhi thora extra paisa '
                                                'dete hain.',
                                  'general_steps': [   'Apni CNIC tayyar rakhein — apni pehchan sabit karne '
                                                       'ke liye zaroorat paray gi',
                                                       'Koi bank ya investment app chunein jo stocks '
                                                       'khareedne dete hain (Pakistan mein kaee baray banks '
                                                       'aur apps yeh offer karte hain)',
                                                       'Apni basic details aur CNIC ke sath aik simple form '
                                                       'bhar kar account kholain — approve hone mein aam tor '
                                                       'par aik do din lagte hain',
                                                       'Apne regular bank account se is nayi investment '
                                                       'account mein kuch paisay transfer karein',
                                                       'Companies ki list dekhein, shuru mein aik ya do '
                                                       'mashhoor companies chunein, aur apna pehla khareed '
                                                       'order dein — app aapko step by step guide karega',
                                                       'Uske baad, bas kabhi kabhi apni app check kar lein '
                                                       'ke aapka paisa kaisa perform kar raha hai — roz '
                                                       'check karne ki zaroorat nahi'],
                                  'risk': {   'level': 'Medium-High',
                                              'note': 'Iska matlab hai ke aapki investment ki qeemat kaafi '
                                                      'upar neechay ja sakti hai — kabhi kabhi to usi hafte '
                                                      'mein. Agar company acha perform kare to aap acha '
                                                      'paisa kama sakte hain; agar mushkil mein ho to aap '
                                                      'apni lagai hui raqam ka kuch hissa kho sakte hain. '
                                                      'Yeh us paisay ke liye behtar hai jo aapko kam az kam '
                                                      'kuch saal tak zaroorat na ho, taake aapke pas ups and '
                                                      'downs jhelnay ka waqt ho.'},
                                  'min_capital': 'Aap sirf PKR 5,000–10,000 se shuru kar sakte hain',
                                  'how_to_invest_pk': [   'Kisi PSX (Pakistan Stock Exchange) registered '
                                                          'broker ke sath brokerage account kholain — jaise '
                                                          'AKD Securities, JS Global, ya psx.com.pk par '
                                                          'listed koi bhi TREC-holder broker',
                                                          'Broker aapke naam par CDC (Central Depository '
                                                          'Company) sub-account khol dega — yahan aapke '
                                                          'shares legally hold hote hain',
                                                          'CNIC aur bank account ke sath KYC complete karein '
                                                          '(ab aksar broker yeh poora online kar dete hain)',
                                                          'Apna trading account fund karein, phir broker ki '
                                                          'app ya web platform (jaise SCSTrade, JS Bank Go, '
                                                          'AKD Trade) se pehla buy order dein',
                                                          'Overseas Pakistani Roshan Digital Account (RDA) '
                                                          'ke zariye invest kar sakte hain, jis ke sath PSX '
                                                          'trading aur CDC account linked hota hai']},
                  'ur': {   'what_is_it': 'جب آپ اسٹاک خریدتے ہیں تو آپ کسی حقیقی کمپنی کا ایک چھوٹا سا حصہ '
                                          'خریدتے ہیں۔ اگر کمپنی اچھی کارکردگی دکھائے تو آپ کا حصہ زیادہ '
                                          'قیمتی ہو جاتا ہے — اور بعض کمپنیاں صرف حصص رکھنے پر بھی تھوڑا '
                                          'اضافی پیسہ دیتی ہیں۔',
                            'general_steps': [   'اپنا شناختی کارڈ تیار رکھیں — اپنی شناخت ثابت کرنے کے لیے '
                                                 'ضرورت پڑے گی',
                                                 'کوئی بینک یا انویسٹمنٹ ایپ چنیں جو اسٹاکس خریدنے دیتی ہے '
                                                 '(پاکستان میں کئی بڑے بینک اور ایپس یہ سہولت دیتے ہیں)',
                                                 'اپنی بنیادی تفصیلات اور شناختی کارڈ کے ساتھ ایک آسان فارم '
                                                 'بھر کر اکاؤنٹ کھولیں — منظوری میں عام طور پر ایک دو دن '
                                                 'لگتے ہیں',
                                                 'اپنے عام بینک اکاؤنٹ سے اس نئے انویسٹمنٹ اکاؤنٹ میں کچھ '
                                                 'رقم منتقل کریں',
                                                 'کمپنیوں کی فہرست دیکھیں، شروع میں ایک یا دو مشہور کمپنیاں '
                                                 'چنیں، اور اپنا پہلا خریداری آرڈر دیں — ایپ آپ کو مرحلہ وار '
                                                 'رہنمائی دے گی',
                                                 'اس کے بعد، بس کبھی کبھار اپنی ایپ چیک کر لیں کہ آپ کا پیسہ '
                                                 'کیسی کارکردگی دکھا رہا ہے — روزانہ چیک کرنے کی ضرورت نہیں'],
                            'risk': {   'level': 'Medium-High',
                                        'note': 'اس کا مطلب ہے کہ آپ کی سرمایہ کاری کی قیمت کافی اوپر نیچے '
                                                'جا سکتی ہے — کبھی کبھی تو اسی ہفتے میں۔ اگر کمپنی اچھی '
                                                'کارکردگی دکھائے تو آپ اچھا پیسہ کما سکتے ہیں؛ اگر مشکل میں '
                                                'ہو تو آپ اپنی لگائی ہوئی رقم کا کچھ حصہ کھو سکتے ہیں۔ یہ اس '
                                                'رقم کے لیے بہتر ہے جس کی آپ کو کم از کم چند سال تک ضرورت نہ '
                                                'ہو، تاکہ آپ کے پاس اتار چڑھاؤ برداشت کرنے کا وقت ہو۔'},
                            'min_capital': 'آپ صرف PKR 5,000 سے 10,000 سے شروع کر سکتے ہیں',
                            'how_to_invest_pk': [   'کسی PSX (پاکستان اسٹاک ایکسچینج) رجسٹرڈ بروکر کے ساتھ '
                                                    'بروکریج اکاؤنٹ کھولیں — جیسے AKD Securities، JS Global، '
                                                    'یا psx.com.pk پر لسٹڈ کوئی بھی TREC-holder بروکر',
                                                    'بروکر آپ کے نام پر CDC (سینٹرل ڈپازٹری کمپنی) سب اکاؤنٹ '
                                                    'کھول دے گا — یہاں آپ کے شیئرز قانونی طور پر رکھے جاتے '
                                                    'ہیں',
                                                    'شناختی کارڈ اور بینک اکاؤنٹ کے ساتھ KYC مکمل کریں (اب '
                                                    'اکثر بروکر یہ مکمل طور پر آن لائن کر دیتے ہیں)',
                                                    'اپنا ٹریڈنگ اکاؤنٹ فنڈ کریں، پھر بروکر کی ایپ یا ویب '
                                                    'پلیٹ فارم (جیسے SCSTrade، JS Bank Go، AKD Trade) سے '
                                                    'پہلا خریداری آرڈر دیں',
                                                    'بیرونِ ملک پاکستانی روشن ڈیجیٹل اکاؤنٹ (RDA) کے ذریعے '
                                                    'سرمایہ کاری کر سکتے ہیں، جس کے ساتھ PSX ٹریڈنگ اور CDC '
                                                    'اکاؤنٹ منسلک ہوتا ہے']}},
    'mutual_funds': {   'en': {   'what_is_it': 'Instead of picking companies yourself, you give your money '
                                                'to a professional team who spreads it across many different '
                                                "options for you — so your money isn't all sitting in one "
                                                'place.',
                                  'general_steps': [   'Decide roughly how comfortable you are with risk — '
                                                       'safer and steady, or open to more ups and downs for '
                                                       'potentially more growth',
                                                       'Pick an investment company or app that offers this '
                                                       'option and matches the risk level you chose',
                                                       'Open an account with your CNIC and basic bank '
                                                       'details — most of this can be done online now',
                                                       'Choose whether you want to put in one lump sum now, '
                                                       'or a small fixed amount automatically every month',
                                                       'Confirm your first payment — after that, the '
                                                       'professional team decides where your money actually '
                                                       'goes',
                                                       "Check in every few months to see how it's growing; "
                                                       "you don't need to manage it day to day"],
                                  'risk': {   'level': 'Medium',
                                              'note': 'The risk depends on which option you pick. Safer '
                                                      'choices barely move and are close to guaranteed; '
                                                      'growth-focused choices can go up and down more, '
                                                      'similar to stocks — but your money is spread across '
                                                      'many companies instead of just one, which makes it '
                                                      'steadier overall.'},
                                  'min_capital': 'Many let you start with just PKR 5,000, or around PKR '
                                                 '1,000 a month',
                                  'how_to_invest_pk': [   'Pick a SECP-licensed Asset Management Company '
                                                          '(AMC) — e.g. NBP Funds, Al Meezan Investments, '
                                                          'HBL Asset Management, or UBL Fund Managers',
                                                          'Compare funds on MUFAP (Mutual Funds Association '
                                                          "of Pakistan, mufap.com.pk) — check the fund's "
                                                          'category, past returns, and risk rating',
                                                          'Open an account directly with the AMC or through '
                                                          'their app/web portal using your CNIC and bank '
                                                          'details',
                                                          'Choose a lump-sum investment or a monthly '
                                                          'Systematic Investment Plan (SIP) auto-debited '
                                                          'from your bank account',
                                                          'Islamic/Shariah-compliant options are available '
                                                          'from the same AMCs if you prefer that route']},
                        'ur_roman': {   'what_is_it': 'Khud companies chunne ki bajaye, aap apni raqam aik '
                                                      'professional team ko dete hain jo usay kaee mukhtalif '
                                                      'jaghon par lagati hai — is tarah aapki poori raqam '
                                                      'aik hi jaga nahi hoti.',
                                        'general_steps': [   'Pehle yeh tay karein ke aap kitna risk lena '
                                                             'comfortable hain — mehfooz aur steady, ya '
                                                             'zyada ups and downs ke sath zyada growth ka '
                                                             'mauka',
                                                             'Koi investment company ya app chunein jo yeh '
                                                             'option offer karti ho aur aapke chunay huay '
                                                             'risk level se match kare',
                                                             'Apni CNIC aur basic bank details ke sath '
                                                             'account kholain — ab aksar yeh sab online ho '
                                                             'sakta hai',
                                                             'Faisla karein ke aap aik hi baar mein lump sum '
                                                             'dalain, ya har mahina choti fixed raqam '
                                                             'automatic dalain',
                                                             'Apni pehli payment confirm karein — uske baad, '
                                                             'professional team ye tay karti hai ke aapka '
                                                             'paisa asal mein kahan lagaya jaye',
                                                             'Chand mahinon baad apna account check karein '
                                                             'ke yeh kaisa barh raha hai; roz manage karne '
                                                             'ki zaroorat nahi'],
                                        'risk': {   'level': 'Medium',
                                                    'note': 'Risk is baat par depend karta hai ke aap kaunsa '
                                                            'option chunte hain. Mehfooz options mushkil se '
                                                            'hilte hain aur taqreeban guaranteed hote hain; '
                                                            'growth-focused options stocks ki tarah zyada '
                                                            'upar neechay ja sakte hain — lekin aapka paisa '
                                                            'kaee companies mein baant diya jata hai na ke '
                                                            'sirf aik mein, jo overall isay zyada steady '
                                                            'bana deta hai.'},
                                        'min_capital': 'Kaee options sirf PKR 5,000 se shuru hone dete hain, '
                                                       'ya taqreeban PKR 1,000 mahana se',
                                        'how_to_invest_pk': [   'Koi SECP-licensed Asset Management Company '
                                                                '(AMC) chunein — jaise NBP Funds, Al Meezan '
                                                                'Investments, HBL Asset Management, ya UBL '
                                                                'Fund Managers',
                                                                'MUFAP (Mutual Funds Association of '
                                                                'Pakistan, mufap.com.pk) par funds compare '
                                                                'karein — fund ki category, past returns, '
                                                                'aur risk rating check karein',
                                                                'AMC ke sath seedha ya unki app/web portal '
                                                                'ke zariye apni CNIC aur bank details se '
                                                                'account kholain',
                                                                'Lump-sum investment ya monthly Systematic '
                                                                'Investment Plan (SIP) chunein jo aapke bank '
                                                                'account se auto-debit ho',
                                                                'Agar chahein to inhi AMCs se '
                                                                'Islamic/Shariah-compliant options bhi '
                                                                'available hain']},
                        'ur': {   'what_is_it': 'خود کمپنیاں چننے کے بجائے، آپ اپنی رقم ایک ماہر ٹیم کو دیتے '
                                                'ہیں جو اسے کئی مختلف جگہوں پر لگاتی ہے — اس طرح آپ کی پوری '
                                                'رقم ایک ہی جگہ نہیں ہوتی۔',
                                  'general_steps': [   'پہلے یہ طے کریں کہ آپ کتنا رسک لینے میں آرام دہ ہیں '
                                                       '— محفوظ اور مستحکم، یا زیادہ اتار چڑھاؤ کے ساتھ '
                                                       'زیادہ ترقی کا موقع',
                                                       'کوئی انویسٹمنٹ کمپنی یا ایپ چنیں جو یہ آپشن پیش کرتی '
                                                       'ہو اور آپ کے چنے ہوئے رسک لیول سے میل کھاتی ہو',
                                                       'اپنے شناختی کارڈ اور بنیادی بینک تفصیلات کے ساتھ '
                                                       'اکاؤنٹ کھولیں — اب اکثر یہ سب آن لائن ہو سکتا ہے',
                                                       'فیصلہ کریں کہ آپ ایک ہی بار میں یک مشت رقم لگائیں، '
                                                       'یا ہر ماہ چھوٹی مقررہ رقم خودکار طریقے سے لگائیں',
                                                       'اپنی پہلی ادائیگی کی تصدیق کریں — اس کے بعد، ماہر '
                                                       'ٹیم یہ طے کرتی ہے کہ آپ کا پیسہ اصل میں کہاں لگایا '
                                                       'جائے',
                                                       'چند ماہ بعد اپنا اکاؤنٹ چیک کریں کہ یہ کیسے بڑھ رہا '
                                                       'ہے؛ روزانہ مینیج کرنے کی ضرورت نہیں'],
                                  'risk': {   'level': 'Medium',
                                              'note': 'رسک اس بات پر منحصر ہے کہ آپ کون سا آپشن چنتے ہیں۔ '
                                                      'محفوظ آپشنز مشکل سے حرکت کرتے ہیں اور تقریباً یقینی '
                                                      'ہوتے ہیں؛ ترقی پر مرکوز آپشنز اسٹاکس کی طرح زیادہ '
                                                      'اوپر نیچے جا سکتے ہیں — لیکن آپ کا پیسہ کئی کمپنیوں '
                                                      'میں بٹا ہوتا ہے نہ کہ صرف ایک میں، جو مجموعی طور پر '
                                                      'اسے زیادہ مستحکم بنا دیتا ہے۔'},
                                  'min_capital': 'کئی آپشنز صرف PKR 5,000 سے شروع ہونے دیتے ہیں، یا تقریباً '
                                                 'PKR 1,000 ماہانہ سے',
                                  'how_to_invest_pk': [   'کوئی SECP سے لائسنس یافتہ ایسٹ مینجمنٹ کمپنی '
                                                          '(AMC) چنیں — جیسے NBP Funds، الميزان انویسٹمنٹس، '
                                                          'HBL ایسٹ مینجمنٹ، یا UBL فنڈ مینیجرز',
                                                          'MUFAP (میوچل فنڈز ایسوسی ایشن آف پاکستان، '
                                                          'mufap.com.pk) پر فنڈز موازنہ کریں — فنڈ کی '
                                                          'کیٹیگری، ماضی کی کارکردگی اور رسک ریٹنگ چیک کریں',
                                                          'AMC کے ساتھ براہِ راست یا ان کی ایپ/ویب پورٹل کے '
                                                          'ذریعے اپنے شناختی کارڈ اور بینک تفصیلات سے اکاؤنٹ '
                                                          'کھولیں',
                                                          'یک مشت سرمایہ کاری یا ماہانہ سسٹمیٹک انویسٹمنٹ '
                                                          'پلان (SIP) چنیں جو آپ کے بینک اکاؤنٹ سے خودکار '
                                                          'کٹے',
                                                          'اگر چاہیں تو اِنہی AMCs سے اسلامی/شرعی اصولوں کے '
                                                          'مطابق آپشنز بھی دستیاب ہیں']}},
    'government_bonds': {   'en': {   'what_is_it': 'You lend your money to the Government of Pakistan for a '
                                                    'set amount of time. In return, they pay it back with a '
                                                    'little extra on top — one of the safest ways to grow '
                                                    'savings.',
                                      'general_steps': [   "Decide how long you're comfortable keeping your "
                                                           'money untouched — a few months, a year, or '
                                                           'longer',
                                                           'Take your CNIC to a National Savings Centre or '
                                                           'any authorized bank near you',
                                                           'Ask the staff which certificate matches how long '
                                                           "you want to save for — they'll walk you through "
                                                           'the exact paperwork',
                                                           'Fill out the form and hand over the amount you '
                                                           'want to save',
                                                           "Keep the certificate they give you safe — it's "
                                                           'proof of your savings',
                                                           'On the date they tell you, go back to collect '
                                                           "your extra money, or let it continue if you'd "
                                                           'rather keep saving'],
                                      'risk': {   'level': 'Low',
                                                  'note': 'This is about as safe as investing gets in '
                                                          'Pakistan, since the government itself is '
                                                          'promising to pay you back. The only real risk is '
                                                          'that if you need your money back early, you might '
                                                          "lose some of the extra amount you would've earned "
                                                          'by waiting it out.'},
                                      'min_capital': 'You can start with as little as PKR 500–5,000',
                                      'how_to_invest_pk': [   'Visit any National Savings Centre, or a '
                                                              "commercial bank's SBP Savings/Investor "
                                                              'Account desk',
                                                              'For Shariah-compliant options, ask about '
                                                              'Government Ijara Sukuk, offered through '
                                                              'PSX-linked bank accounts',
                                                              'Overseas Pakistanis can invest via Roshan '
                                                              'Digital Account into Naya Pakistan '
                                                              'Certificates or Sukuk, entirely online',
                                                              'Complete the form with your CNIC, choose the '
                                                              'tenure (from a few months to several years), '
                                                              'and deposit your amount',
                                                              'Keep your certificate or account statement '
                                                              "safe — it's your proof of ownership and "
                                                              'needed at maturity']},
                            'ur_roman': {   'what_is_it': 'Aap apni raqam aik muqarrarah waqt ke liye '
                                                          'Hakoomat-e-Pakistan ko udhaar dete hain. Badle '
                                                          'mein wo aapko waapis thora extra paisa ke sath '
                                                          'dete hain — savings barhane ka aik sab se mehfooz '
                                                          'tareeqa.',
                                            'general_steps': [   'Tay karein ke aap kitne arsay ke liye apni '
                                                                 'raqam bagair chhue rakhna chahte hain — '
                                                                 'chand mahinay, aik saal, ya usse zyada',
                                                                 'Apni CNIC lekar apne qareeb ke National '
                                                                 'Savings Centre ya kisi authorized bank '
                                                                 'jayein',
                                                                 'Staff se poochein ke kaunsa certificate '
                                                                 'aapke chunay huay arsay se match karta hai '
                                                                 '— wo aapko poora paperwork samjha denge',
                                                                 'Form bharein aur jo raqam save karna '
                                                                 'chahte hain wo jama karwayein',
                                                                 'Jo certificate wo aapko dein usay mehfooz '
                                                                 'rakhein — yeh aapki saving ka saboot hai',
                                                                 'Jo tareekh wo batayein, us din waapis ja '
                                                                 'kar apni extra raqam le lein, ya agar aap '
                                                                 'chahein to isay aagay bhi chalne dein'],
                                            'risk': {   'level': 'Low',
                                                        'note': 'Yeh Pakistan mein invest karne ka taqreeban '
                                                                'sab se mehfooz tareeqa hai, kyunke khud '
                                                                'hakoomat aapko waapis paisa dene ka waada '
                                                                'karti hai. Sirf aik risk yeh hai ke agar '
                                                                'aapko apni raqam jaldi wapis chahiye ho, to '
                                                                'ho sakta hai aapko wo extra raqam na mile '
                                                                'jo poora intezaar karne par milti.'},
                                            'min_capital': 'Aap sirf PKR 500–5,000 se shuru kar sakte hain',
                                            'how_to_invest_pk': [   'Koi bhi National Savings Centre, ya '
                                                                    'commercial bank ke SBP Savings/Investor '
                                                                    'Account desk par jayein',
                                                                    'Shariah-compliant option ke liye, '
                                                                    'Government Ijara Sukuk ke baray mein '
                                                                    'poochein, jo PSX-linked bank accounts '
                                                                    'ke zariye milta hai',
                                                                    'Overseas Pakistani Roshan Digital '
                                                                    'Account ke zariye Naya Pakistan '
                                                                    'Certificates ya Sukuk mein, poori tarah '
                                                                    'online invest kar sakte hain',
                                                                    'CNIC ke sath form complete karein, '
                                                                    'tenure chunein (chand mahinon se kaee '
                                                                    'saal tak), aur apni raqam jama '
                                                                    'karwayein',
                                                                    'Apna certificate ya account statement '
                                                                    'mehfooz rakhein — yeh malkiyat ka '
                                                                    'saboot hai aur maturity par chahiye '
                                                                    'hoga']},
                            'ur': {   'what_is_it': 'آپ اپنی رقم ایک مقررہ وقت کے لیے حکومتِ پاکستان کو '
                                                    'ادھار دیتے ہیں۔ بدلے میں وہ آپ کو تھوڑی اضافی رقم کے '
                                                    'ساتھ واپس کرتی ہے — بچت بڑھانے کا ایک محفوظ ترین طریقہ۔',
                                      'general_steps': [   'طے کریں کہ آپ کتنے عرصے کے لیے اپنی رقم بغیر '
                                                           'چھوئے رکھنا چاہتے ہیں — چند ماہ، ایک سال، یا اس '
                                                           'سے زیادہ',
                                                           'اپنا شناختی کارڈ لے کر اپنے قریبی نیشنل سیونگز '
                                                           'سینٹر یا کسی مجاز بینک جائیں',
                                                           'عملے سے پوچھیں کہ کون سا سرٹیفکیٹ آپ کے چنے ہوئے '
                                                           'عرصے سے میل کھاتا ہے — وہ آپ کو پورا طریقہ کار '
                                                           'سمجھا دیں گے',
                                                           'فارم بھریں اور جو رقم بچانا چاہتے ہیں وہ جمع '
                                                           'کروائیں',
                                                           'جو سرٹیفکیٹ وہ آپ کو دیں اسے محفوظ رکھیں — یہ آپ '
                                                           'کی بچت کا ثبوت ہے',
                                                           'جو تاریخ وہ بتائیں، اس دن واپس جا کر اپنی اضافی '
                                                           'رقم لے لیں، یا اگر چاہیں تو اسے آگے بھی جاری '
                                                           'رہنے دیں'],
                                      'risk': {   'level': 'Low',
                                                  'note': 'یہ پاکستان میں سرمایہ کاری کرنے کا تقریباً سب سے '
                                                          'محفوظ طریقہ ہے، کیونکہ خود حکومت آپ کو رقم واپس '
                                                          'کرنے کا وعدہ کرتی ہے۔ صرف ایک خطرہ یہ ہے کہ اگر '
                                                          'آپ کو اپنی رقم جلدی واپس چاہیے ہو، تو ممکن ہے آپ '
                                                          'کو وہ اضافی رقم نہ ملے جو پورا انتظار کرنے پر '
                                                          'ملتی۔'},
                                      'min_capital': 'آپ صرف PKR 500 سے 5,000 سے شروع کر سکتے ہیں',
                                      'how_to_invest_pk': [   'کسی بھی نیشنل سیونگز سینٹر، یا کمرشل بینک کے '
                                                              'SBP سیونگز/انویسٹر اکاؤنٹ ڈیسک پر جائیں',
                                                              'شرعی اصولوں کے مطابق آپشن کے لیے، گورنمنٹ '
                                                              'اجارہ صکوک کے بارے میں پوچھیں، جو PSX سے '
                                                              'منسلک بینک اکاؤنٹس کے ذریعے ملتا ہے',
                                                              'بیرونِ ملک پاکستانی روشن ڈیجیٹل اکاؤنٹ کے '
                                                              'ذریعے نیا پاکستان سرٹیفکیٹس یا صکوک میں، مکمل '
                                                              'طور پر آن لائن سرمایہ کاری کر سکتے ہیں',
                                                              'شناختی کارڈ کے ساتھ فارم مکمل کریں، مدت چنیں '
                                                              '(چند ماہ سے کئی سال تک)، اور اپنی رقم جمع '
                                                              'کروائیں',
                                                              'اپنا سرٹیفکیٹ یا اکاؤنٹ اسٹیٹمنٹ محفوظ رکھیں '
                                                              '— یہ ملکیت کا ثبوت ہے اور میعاد پوری ہونے پر '
                                                              'درکار ہوگا']}},
    'gold': {   'en': {   'what_is_it': 'Gold has held its value in Pakistan for generations. You can own '
                                        'real gold — jewelry, coins, or bars — or buy small amounts of '
                                        'digital gold through an app, without needing to store anything '
                                        'yourself.',
                          'general_steps': [   'Decide if you want real gold you can hold, or a smaller '
                                               'digital amount through an app',
                                               'If buying real gold: find a trusted jeweler or bank that '
                                               'gives you a proper certificate',
                                               'If buying digital gold: download the app, verify your '
                                               'identity, and add money to buy however much you want',
                                               "Check that day's gold price before buying, so you know "
                                               "exactly what you're paying for",
                                               "If it's real gold, store it somewhere safe like a bank "
                                               'locker rather than at home',
                                               'Whenever you want your money back, sell it back at the '
                                               "jeweler, bank, or app — you'll get whatever the price is "
                                               'that day'],
                          'risk': {   'level': 'Medium',
                                      'note': "Gold usually doesn't crash suddenly, but its price does move "
                                              "up and down with world markets and the rupee's value against "
                                              "the dollar. It's generally seen as a safer choice than "
                                              "stocks, but it's not guaranteed to always go up, and there "
                                              'can be slow stretches where the price barely moves.'},
                          'min_capital': 'Digital gold can start from just a few thousand rupees; physical '
                                         'gold costs whatever 1 gram is priced at that day',
                          'how_to_invest_pk': [   'For digital gold: use a PMEX (Pakistan Mercantile '
                                                  "Exchange)-linked app or a bank's digital gold product to "
                                                  'buy in small amounts',
                                                  'For physical gold: buy from a registered jeweler in a '
                                                  'Sarafa Bazaar, or a bank offering gold bars/coins with a '
                                                  'purity certificate',
                                                  "Always check that day's gold rate (published by the "
                                                  'Sarafa Bazaar/All Pakistan Sarafa Association) before you '
                                                  'buy or sell',
                                                  'For physical gold, store it in a bank locker rather than '
                                                  'at home',
                                                  'To cash out, sell back to the same jeweler, bank, or app '
                                                  "at that day's rate"]},
                'ur_roman': {   'what_is_it': 'Sona Pakistan mein naslon se apni qeemat rakhta aaya hai. Aap '
                                              'asli sona — zevraat, sikkay, ya bars — rakh sakte hain, ya '
                                              'app ke zariye chota sa digital sona khareed sakte hain, '
                                              'bagair kuch physically sambhalay.',
                                'general_steps': [   'Tay karein ke aap asli sona chahte hain jise haath '
                                                     'mein pakar sakein, ya app ke zariye chota digital '
                                                     'amount',
                                                     'Agar asli sona khareedna hai: koi bharosemand jeweler '
                                                     'ya bank dhoondein jo sahi certificate de',
                                                     'Agar digital gold khareedna hai: app download karein, '
                                                     'apni pehchan verify karein, aur jitna chahein utna '
                                                     'khareedne ke liye paisay dalain',
                                                     'Khareedne se pehle us din ki sona qeemat check kar '
                                                     'lein, taake pata ho aap kya qeemat de rahe hain',
                                                     'Agar asli sona hai, to usay ghar ki bajaye bank locker '
                                                     'jaisi mehfooz jaga par rakhein',
                                                     'Jab bhi apna paisa waapis chahiye, usay jeweler, bank, '
                                                     'ya app par waapis bech dein — us din ki qeemat par jo '
                                                     'bhi ho'],
                                'risk': {   'level': 'Medium',
                                            'note': 'Sona aksar achanak crash nahi hota, lekin iski qeemat '
                                                    'world markets aur rupee ki dollar ke muqable value ke '
                                                    'sath upar neechay hoti rehti hai. Yeh aam tor par '
                                                    'stocks se zyada mehfooz mana jata hai, lekin hamesha '
                                                    'upar jane ki guarantee nahi hoti, aur kabhi kabhi '
                                                    'lambay arsay tak qeemat mushkil se harkat karti hai.'},
                                'min_capital': 'Digital gold chand hazar rupay se shuru ho sakta hai; '
                                               'physical sona us din ki 1 gram qeemat ke barabar hoga',
                                'how_to_invest_pk': [   'Digital gold ke liye: PMEX (Pakistan Mercantile '
                                                        'Exchange)-linked app ya kisi bank ka digital gold '
                                                        'product istemal karein, choti amounts mein '
                                                        'khareedne ke liye',
                                                        'Physical gold ke liye: Sarafa Bazaar ke kisi '
                                                        'registered jeweler se, ya kisi bank se jo purity '
                                                        'certificate ke sath gold bars/coins deta ho, '
                                                        'khareedain',
                                                        'Khareedne ya bechne se pehle hamesha us din ki gold '
                                                        'rate check karein (Sarafa Bazaar/All Pakistan '
                                                        'Sarafa Association se publish hoti hai)',
                                                        'Physical gold ke liye, isay ghar ki bajaye bank '
                                                        'locker mein rakhein',
                                                        'Paisay wapis lene ke liye, usi jeweler, bank, ya '
                                                        'app ko us din ki rate par wapis bech dein']},
                'ur': {   'what_is_it': 'سونا پاکستان میں نسلوں سے اپنی قدر برقرار رکھے ہوئے ہے۔ آپ اصلی '
                                        'سونا — زیورات، سکے، یا بارز — رکھ سکتے ہیں، یا ایپ کے ذریعے تھوڑا '
                                        'سا ڈیجیٹل سونا خرید سکتے ہیں، بغیر کچھ خود سنبھالے۔',
                          'general_steps': [   'طے کریں کہ آپ اصلی سونا چاہتے ہیں جسے ہاتھ میں پکڑ سکیں، یا '
                                               'ایپ کے ذریعے تھوڑی ڈیجیٹل مقدار',
                                               'اگر اصلی سونا خریدنا ہے: کوئی قابلِ اعتماد جیولر یا بینک '
                                               'ڈھونڈیں جو صحیح سرٹیفکیٹ دے',
                                               'اگر ڈیجیٹل گولڈ خریدنا ہے: ایپ ڈاؤن لوڈ کریں، اپنی شناخت '
                                               'ثابت کریں، اور جتنا چاہیں اتنا خریدنے کے لیے رقم ڈالیں',
                                               'خریدنے سے پہلے اس دن کی سونے کی قیمت چیک کر لیں، تاکہ پتا ہو '
                                               'آپ کیا قیمت دے رہے ہیں',
                                               'اگر اصلی سونا ہے، تو اسے گھر کی بجائے بینک لاکر جیسی محفوظ '
                                               'جگہ پر رکھیں',
                                               'جب بھی اپنا پیسہ واپس چاہیے، اسے جیولر، بینک، یا ایپ پر واپس '
                                               'بیچ دیں — اس دن کی قیمت پر جو بھی ہو'],
                          'risk': {   'level': 'Medium',
                                      'note': 'سونا اکثر اچانک کریش نہیں ہوتا، لیکن اس کی قیمت عالمی مارکیٹس '
                                              'اور روپے کی ڈالر کے مقابلے قدر کے ساتھ اوپر نیچے ہوتی رہتی '
                                              'ہے۔ یہ عام طور پر اسٹاکس سے زیادہ محفوظ سمجھا جاتا ہے، لیکن '
                                              'ہمیشہ اوپر جانے کی ضمانت نہیں ہوتی، اور کبھی کبھار لمبے عرصے '
                                              'تک قیمت مشکل سے حرکت کرتی ہے۔'},
                          'min_capital': 'ڈیجیٹل گولڈ چند ہزار روپے سے شروع ہو سکتا ہے؛ فزیکل سونے کی قیمت '
                                         'اس دن کے 1 گرام کے برابر ہوگی',
                          'how_to_invest_pk': [   'ڈیجیٹل سونے کے لیے: PMEX (پاکستان مرکنٹائل ایکسچینج) سے '
                                                  'منسلک ایپ یا کسی بینک کی ڈیجیٹل گولڈ پروڈکٹ استعمال کریں، '
                                                  'تھوڑی مقدار میں خریدنے کے لیے',
                                                  'اصلی سونے کے لیے: صرافہ بازار کے کسی رجسٹرڈ جیولر سے، یا '
                                                  'کسی بینک سے جو خالص پن کے سرٹیفکیٹ کے ساتھ سونے کی '
                                                  'اینٹیں/سکے دیتا ہو، خریدیں',
                                                  'خریدنے یا بیچنے سے پہلے ہمیشہ اس دن کی سونے کی قیمت چیک '
                                                  'کریں (صرافہ بازار/آل پاکستان صرافہ ایسوسی ایشن سے شائع '
                                                  'ہوتی ہے)',
                                                  'اصلی سونے کے لیے، اسے گھر کی بجائے بینک لاکر میں رکھیں',
                                                  'رقم واپس لینے کے لیے، اسی جیولر، بینک، یا ایپ کو اس دن کی '
                                                  'قیمت پر واپس بیچ دیں']}},
    'fixed_deposits': {   'en': {   'what_is_it': 'You give the bank a set amount of money for a fixed '
                                                  'period, and they promise to pay it back with a little '
                                                  'extra on top — simple, predictable, and low-effort.',
                                    'general_steps': [   'Decide how much money you can set aside without '
                                                         'needing to touch it for a while',
                                                         'Visit your bank, or open one through their app if '
                                                         'they offer it',
                                                         'Choose how long you want to lock it in for — '
                                                         'anywhere from 1 month to 5 years',
                                                         "Ask what extra amount they'll pay you for each "
                                                         'option, and pick the one that suits you best',
                                                         'Deposit your money and keep the certificate or '
                                                         'receipt they give you safe',
                                                         'On the date it matures, collect your money plus '
                                                         'the extra amount — or roll it into a new deposit '
                                                         'if you want to keep saving'],
                                    'risk': {   'level': 'Low',
                                                'note': 'This is one of the safest ways to grow your money, '
                                                        'since the bank agrees upfront exactly how much '
                                                        "extra you'll get and doesn't change it later. The "
                                                        'main downside is that if you need your money out '
                                                        'early, you may lose some or all of the extra amount '
                                                        'you would have earned.'},
                                    'min_capital': 'Most banks let you start with PKR 10,000–50,000',
                                    'how_to_invest_pk': [   'Visit any commercial or Islamic bank you '
                                                            'already have an account with — most now offer '
                                                            'this through their mobile app too',
                                                            'Ask for a Term Deposit Receipt (TDR) — or, at '
                                                            'an Islamic bank, a Shariah-compliant Term '
                                                            'Deposit under a Mudarabah structure',
                                                            "Choose a tenure that matches when you'll "
                                                            'actually need the money — from 1 month up to 5 '
                                                            'years',
                                                            'Compare the profit rate the bank offers for '
                                                            'each tenure before locking in',
                                                            'Deposit your amount and keep the TDR '
                                                            'certificate or e-statement safe until '
                                                            'maturity']},
                          'ur_roman': {   'what_is_it': 'Aap bank ko aik muqarrarah muddat ke liye aik fixed '
                                                        'raqam dete hain, aur wo waada karte hain ke usay '
                                                        'thora extra paisa ke sath waapis karenge — simple, '
                                                        'predictable, aur bagair mehnat ke.',
                                          'general_steps': [   'Tay karein ke kitni raqam aap bagair chhue '
                                                               'kuch arsay ke liye alag rakh sakte hain',
                                                               'Apne bank jayein, ya agar wo offer karte '
                                                               'hain to unki app ke zariye kholain',
                                                               'Chunein ke kitne arsay ke liye lock karna '
                                                               'chahte hain — 1 mahina se 5 saal tak kuch '
                                                               'bhi',
                                                               'Poochein ke har option par wo kitni extra '
                                                               'raqam denge, aur jo aapko suit kare wo '
                                                               'chunein',
                                                               'Apni raqam jama karwayein aur jo certificate '
                                                               'ya receipt mile usay mehfooz rakhein',
                                                               'Jab yeh maturity par pohanche, apni raqam '
                                                               'extra amount samait le lein — ya agar aap '
                                                               'saving jari rakhna chahte hain to isay '
                                                               'dobara invest kar dein'],
                                          'risk': {   'level': 'Low',
                                                      'note': 'Yeh apna paisa barhane ke sab se mehfooz '
                                                              'tareeqon mein se aik hai, kyunke bank pehle '
                                                              'hi tay kar leta hai ke aapko kitni extra '
                                                              'raqam milegi aur baad mein isay badalta nahi. '
                                                              'Sabse bari mushkil yeh hai ke agar aapko '
                                                              'jaldi paisa nikalna paray, to ho sakta hai '
                                                              'aap kuch ya sari extra raqam kho dein jo '
                                                              'aapko poora intezaar karne par milti.'},
                                          'min_capital': 'Zyada tar banks PKR 10,000–50,000 se shuru karne '
                                                         'dete hain',
                                          'how_to_invest_pk': [   'Kisi bhi commercial ya Islamic bank jahan '
                                                                  'aapka pehle se account hai, wahan jayein '
                                                                  '— ab aksar yeh mobile app se bhi ho jata '
                                                                  'hai',
                                                                  'Term Deposit Receipt (TDR) ke liye '
                                                                  'poochein — ya Islamic bank mein, '
                                                                  'Mudarabah structure ke tehat '
                                                                  'Shariah-compliant Term Deposit',
                                                                  'Aisi tenure chunein jo us waqt se match '
                                                                  'kare jab aapko waqai paisa chahiye ho — 1 '
                                                                  'mahina se 5 saal tak',
                                                                  'Lock karne se pehle har tenure par bank '
                                                                  'ki offer ki hui profit rate compare '
                                                                  'karein',
                                                                  'Apni raqam jama karwayein aur maturity '
                                                                  'tak TDR certificate ya e-statement '
                                                                  'mehfooz rakhein']},
                          'ur': {   'what_is_it': 'آپ بینک کو ایک مقررہ مدت کے لیے ایک فکسڈ رقم دیتے ہیں، '
                                                  'اور وہ وعدہ کرتے ہیں کہ اسے تھوڑی اضافی رقم کے ساتھ واپس '
                                                  'کریں گے — آسان، قابلِ پیش گوئی، اور بغیر کسی محنت کے۔',
                                    'general_steps': [   'طے کریں کہ کتنی رقم آپ بغیر چھوئے کچھ عرصے کے لیے '
                                                         'الگ رکھ سکتے ہیں',
                                                         'اپنے بینک جائیں، یا اگر وہ پیش کرتے ہیں تو ان کی '
                                                         'ایپ کے ذریعے کھولیں',
                                                         'طے کریں کہ کتنے عرصے کے لیے لاک کرنا چاہتے ہیں — 1 '
                                                         'ماہ سے 5 سال تک کچھ بھی',
                                                         'پوچھیں کہ ہر آپشن پر وہ کتنی اضافی رقم دیں گے، اور '
                                                         'جو آپ کو موزوں لگے وہ چنیں',
                                                         'اپنی رقم جمع کروائیں اور جو سرٹیفکیٹ یا رسید ملے '
                                                         'اسے محفوظ رکھیں',
                                                         'جب یہ میعاد مکمل ہو، اپنی رقم اضافی رقم سمیت لے '
                                                         'لیں — یا اگر آپ بچت جاری رکھنا چاہتے ہیں تو اسے '
                                                         'دوبارہ لگا دیں'],
                                    'risk': {   'level': 'Low',
                                                'note': 'یہ اپنا پیسہ بڑھانے کے سب سے محفوظ طریقوں میں سے '
                                                        'ایک ہے، کیونکہ بینک پہلے ہی طے کر لیتا ہے کہ آپ کو '
                                                        'کتنی اضافی رقم ملے گی اور بعد میں اسے بدلتا نہیں۔ '
                                                        'سب سے بڑی مشکل یہ ہے کہ اگر آپ کو جلدی پیسہ نکالنا '
                                                        'پڑے، تو ممکن ہے آپ کچھ یا ساری اضافی رقم کھو دیں جو '
                                                        'آپ کو پورا انتظار کرنے پر ملتی۔'},
                                    'min_capital': 'زیادہ تر بینک PKR 10,000 سے 50,000 سے شروع کرنے دیتے ہیں',
                                    'how_to_invest_pk': [   'کسی بھی کمرشل یا اسلامی بینک جہاں آپ کا پہلے سے '
                                                            'اکاؤنٹ ہے، وہاں جائیں — اب اکثر یہ موبائل ایپ '
                                                            'سے بھی ہو جاتا ہے',
                                                            'ٹرم ڈپازٹ رسید (TDR) کے لیے پوچھیں — یا اسلامی '
                                                            'بینک میں، مضاربہ ڈھانچے کے تحت شرعی اصولوں کے '
                                                            'مطابق ٹرم ڈپازٹ',
                                                            'ایسی مدت چنیں جو اس وقت سے میل کھائے جب آپ کو '
                                                            'واقعی رقم چاہیے ہو — 1 ماہ سے 5 سال تک',
                                                            'لاک کرنے سے پہلے ہر مدت پر بینک کی پیش کردہ '
                                                            'منافع کی شرح کا موازنہ کریں',
                                                            'اپنی رقم جمع کروائیں اور میعاد پوری ہونے تک TDR '
                                                            'سرٹیفکیٹ یا ای-اسٹیٹمنٹ محفوظ رکھیں']}},
    'crypto': {   'en': {   'what_is_it': "Crypto (like Bitcoin) is digital money that isn't controlled by "
                                          'any bank or government. Pakistan recently introduced new rules '
                                          "and a watchdog body to keep an eye on crypto companies — but it's "
                                          'still very new and can be confusing.',
                            'general_steps': [   'Understand this is a high-risk option — only continue if '
                                                 "you're comfortable with that",
                                                 'Check which platforms are officially approved under '
                                                 "Pakistan's new crypto rules before choosing one",
                                                 'Sign up and complete their identity verification process',
                                                 "Start with a very small amount you're fully okay losing, "
                                                 'just to understand how it works',
                                                 'Turn on extra security features like two-step verification '
                                                 'right away',
                                                 'Keep a close eye on price changes, since crypto can move a '
                                                 'lot in a single day — never invest money you need for '
                                                 'daily expenses'],
                            'risk': {   'level': 'High',
                                        'note': 'This is the riskiest option here by far. Prices can jump up '
                                                'or crash down by a large amount in a single day, sometimes '
                                                "with little warning. Pakistan's rules around crypto are "
                                                "also still being finalized, so there's uncertainty beyond "
                                                'just the price. Only ever use money you could fully afford '
                                                'to lose.'},
                            'min_capital': "There's no fixed minimum — but only put in money you're fully "
                                           'prepared to lose',
                            'how_to_invest_pk': [   "Check which platforms operate under Pakistan's Virtual "
                                                    'Assets framework and the Pakistan Virtual Assets '
                                                    'Regulatory Authority (PVARA) before choosing one',
                                                    'Sign up and complete identity verification (KYC) on the '
                                                    'platform',
                                                    'Start with a very small, fully-affordable-to-lose '
                                                    'amount to learn how it works',
                                                    'Turn on two-factor authentication (2FA) immediately '
                                                    'after account creation',
                                                    "Never share your wallet's private keys or recovery "
                                                    'phrase with anyone, including anyone claiming to be '
                                                    'support staff']},
                  'ur_roman': {   'what_is_it': 'Crypto (jaise Bitcoin) aik digital paisa hai jo kisi bank '
                                                'ya hakoomat ke control mein nahi hota. Pakistan ne hal hi '
                                                'mein naye rules aur crypto companies par nazar rakhne wala '
                                                'aik idara banaya hai — lekin yeh abhi bhi bohat naya aur '
                                                'confusing ho sakta hai.',
                                  'general_steps': [   'Samjhein ke yeh aik high-risk option hai — sirf tab '
                                                       'aagay barhein agar aap is se comfortable hain',
                                                       'Koi platform chunne se pehle check karein ke wo '
                                                       'Pakistan ke naye crypto rules ke tehat officially '
                                                       'approved hai',
                                                       'Sign up karein aur unka identity verification '
                                                       'process complete karein',
                                                       'Bohat choti raqam se shuru karein jise kho kar bhi '
                                                       'aap poori tarah theek hon, sirf yeh samajhne ke liye '
                                                       'ke yeh kaise kaam karta hai',
                                                       'Turant extra security features (jaise two-step '
                                                       'verification) on kar dein',
                                                       'Qeematon par nazar rakhein, kyunke crypto aik hi din '
                                                       'mein kaafi badal sakta hai — kabhi bhi wo paisa '
                                                       'invest na karein jo aapko rozana kharch ke liye '
                                                       'chahiye'],
                                  'risk': {   'level': 'High',
                                              'note': 'Yeh yahan sab se zyada risky option hai. Qeematain '
                                                      'aik hi din mein bohat zyada upar ja sakti hain ya '
                                                      'crash ho sakti hain, kabhi kabhi bina zyada warning '
                                                      'ke. Pakistan mein crypto ke rules bhi abhi tay ho '
                                                      'rahe hain, is liye sirf qeemat hi nahi balke aur bhi '
                                                      'uncertainty hai. Sirf wahi paisa istemal karein jise '
                                                      'kho kar bhi aap poori tarah theek hon.'},
                                  'min_capital': 'Koi fixed minimum nahi hai — lekin sirf itni raqam dalain '
                                                 'jo aap poori tarah kho sakte hain',
                                  'how_to_invest_pk': [   'Koi platform chunne se pehle check karein ke wo '
                                                          'Pakistan ke Virtual Assets framework aur Pakistan '
                                                          'Virtual Assets Regulatory Authority (PVARA) ke '
                                                          'tehat operate karta hai',
                                                          'Platform par sign up karein aur identity '
                                                          'verification (KYC) complete karein',
                                                          'Bohat choti, poori tarah afford-to-lose raqam se '
                                                          'shuru karein, yeh samajhne ke liye ke yeh kaise '
                                                          'kaam karta hai',
                                                          'Account banane ke foran baad two-factor '
                                                          'authentication (2FA) on kar dein',
                                                          'Apne wallet ki private keys ya recovery phrase '
                                                          'kisi ke sath share na karein, chahay wo khud ko '
                                                          'support staff hi kyun na kahay']},
                  'ur': {   'what_is_it': 'کرپٹو (جیسے بٹ کوائن) ایک ڈیجیٹل رقم ہے جو کسی بینک یا حکومت کے '
                                          'کنٹرول میں نہیں ہوتی۔ پاکستان نے حال ہی میں نئے قوانین اور کرپٹو '
                                          'کمپنیوں پر نظر رکھنے والا ایک ادارہ بنایا ہے — لیکن یہ ابھی بھی '
                                          'بہت نیا اور الجھا ہوا ہو سکتا ہے۔',
                            'general_steps': [   'سمجھیں کہ یہ ایک ہائی رسک آپشن ہے — صرف تب آگے بڑھیں اگر '
                                                 'آپ اس سے آرام دہ ہیں',
                                                 'کوئی پلیٹ فارم چننے سے پہلے چیک کریں کہ وہ پاکستان کے نئے '
                                                 'کرپٹو قوانین کے تحت باقاعدہ منظور شدہ ہے',
                                                 'سائن اپ کریں اور ان کا شناختی تصدیقی عمل مکمل کریں',
                                                 'بہت چھوٹی رقم سے شروعات کریں جسے کھو کر بھی آپ مکمل طور پر '
                                                 'ٹھیک ہوں، صرف یہ سمجھنے کے لیے کہ یہ کیسے کام کرتا ہے',
                                                 'فوراً اضافی سیکیورٹی فیچرز (جیسے ٹو اسٹیپ ویریفیکیشن) آن '
                                                 'کر دیں',
                                                 'قیمتوں پر نظر رکھیں، کیونکہ کرپٹو ایک ہی دن میں کافی بدل '
                                                 'سکتا ہے — کبھی بھی وہ رقم سرمایہ کاری نہ کریں جو آپ کو '
                                                 'روزانہ خرچ کے لیے چاہیے'],
                            'risk': {   'level': 'High',
                                        'note': 'یہ یہاں سب سے زیادہ خطرناک آپشن ہے۔ قیمتیں ایک ہی دن میں '
                                                'بہت زیادہ اوپر جا سکتی ہیں یا کریش ہو سکتی ہیں، کبھی کبھی '
                                                'بغیر زیادہ وارننگ کے۔ پاکستان میں کرپٹو کے قوانین بھی ابھی '
                                                'طے ہو رہے ہیں، اس لیے صرف قیمت ہی نہیں بلکہ اور بھی غیر '
                                                'یقینی صورتحال ہے۔ صرف وہی رقم استعمال کریں جسے کھو کر بھی '
                                                'آپ مکمل طور پر ٹھیک ہوں۔'},
                            'min_capital': 'کوئی مقررہ کم از کم رقم نہیں — لیکن صرف اتنی رقم لگائیں جسے آپ '
                                           'مکمل طور پر کھو سکتے ہیں',
                            'how_to_invest_pk': [   'کوئی پلیٹ فارم چننے سے پہلے چیک کریں کہ وہ پاکستان کے '
                                                    'ورچوئل ایسٹس فریم ورک اور پاکستان ورچوئل ایسٹس '
                                                    'ریگولیٹری اتھارٹی (PVARA) کے تحت کام کرتا ہے',
                                                    'پلیٹ فارم پر سائن اپ کریں اور شناختی تصدیق (KYC) مکمل '
                                                    'کریں',
                                                    'بہت چھوٹی، مکمل طور پر برداشت کے قابل رقم سے شروعات '
                                                    'کریں، یہ سمجھنے کے لیے کہ یہ کیسے کام کرتا ہے',
                                                    'اکاؤنٹ بنانے کے فوراً بعد ٹو-فیکٹر ایوتھینٹیکیشن (2FA) '
                                                    'آن کر دیں',
                                                    'اپنے والٹ کی پرائیویٹ کیز یا ریکوری فریز کسی کے ساتھ '
                                                    'شیئر نہ کریں، چاہے وہ خود کو سپورٹ اسٹاف ہی کیوں نہ '
                                                    'کہے']}}}


# ─────────────────────────────────────────────────────────────────────────────
# 5. Exclusion-reason and scenario-advisory text (multilingual, hardcoded).
# ─────────────────────────────────────────────────────────────────────────────

# ─────────────────────────────────────────────────────────────────────────────
# Deterministic exclusion-reason text (multilingual)
# Rules verified 1:1 against the 243-row scenario matrix — see comments below.
# ─────────────────────────────────────────────────────────────────────────────

EXCLUSION_REASON_TEXT = {
    'stocks_no_experience': {
        'en': "You haven't invested before — stocks move quickly and are easier to handle once you've built some hands-on experience first.",
        'ur_roman': "Aapne pehle kabhi invest nahi kiya — stocks ki qeemat tezi se badalti hai, isay handle karna aasan tab hota hai jab aapke pass thora hands-on tajurba ho.",
        'ur': "آپ نے پہلے کبھی سرمایہ کاری نہیں کی — اسٹاکس کی قیمت تیزی سے بدلتی ہے، اسے سنبھالنا اس وقت آسان ہوتا ہے جب آپ کے پاس تھوڑا تجربہ ہو۔",
    },
    'stocks_short_horizon': {
        'en': "You'll need this money in under a year, and stock prices can drop sharply in that window with no guarantee of recovering in time.",
        'ur_roman': "Aapko yeh paisa 1 saal se kam mein chahiye hoga, aur is arsay mein stock prices kaafi gir sakti hain, waqt par recover hone ki guarantee nahi hoti.",
        'ur': "آپ کو یہ رقم ایک سال سے کم عرصے میں چاہیے ہوگی، اور اس دوران اسٹاک کی قیمتیں کافی گر سکتی ہیں، وقت پر بحال ہونے کی کوئی ضمانت نہیں۔",
    },
    'stocks_emergency_fund': {
        'en': "This is your emergency fund — it needs to be stable and available instantly, but stock values can fall right when you need to withdraw.",
        'ur_roman': "Yeh aapka emergency fund hai — isay stable aur foran available hona chahiye, lekin stock values usi waqt gir sakti hain jab aapko nikalna ho.",
        'ur': "یہ آپ کا ہنگامی فنڈ ہے — اسے مستحکم اور فوری طور پر دستیاب ہونا چاہیے، لیکن اسٹاک کی قیمتیں عین اس وقت گر سکتی ہیں جب آپ کو نکالنا ہو۔",
    },
    'mutual_funds_emergency_fund': {
        'en': "This is your emergency fund — fund values can dip in the short term, and cashing out isn't always same-day, so it isn't the right fit here.",
        'ur_roman': "Yeh aapka emergency fund hai — fund ki value short term mein gir sakti hai, aur cash out hamesha usi din nahi hota, is liye yeh yahan sahi fit nahi.",
        'ur': "یہ آپ کا ہنگامی فنڈ ہے — فنڈ کی قیمت مختصر مدت میں گر سکتی ہے، اور رقم نکالنا ہمیشہ اسی دن ممکن نہیں ہوتا، اس لیے یہ یہاں موزوں نہیں۔",
    },
    'crypto_experience': {
        'en': "Crypto prices swing hard and fast — it's safer to build some general investing experience before taking this on.",
        'ur_roman': "Crypto ki qeematain tezi se aur bohat zyada upar neechay hoti hain — behtar hai ke pehle thora general investing tajurba ho jaye.",
        'ur': "کرپٹو کی قیمتیں تیزی سے اور بہت زیادہ اوپر نیچے ہوتی ہیں — بہتر ہے کہ پہلے کچھ عمومی سرمایہ کاری کا تجربہ حاصل کر لیا جائے۔",
    },
    'crypto_risk_comfort': {
        'en': "Crypto can rise or fall by a large amount in a single day — that level of swing doesn't match your current risk comfort.",
        'ur_roman': "Crypto aik hi din mein kaafi upar ya neechay ja sakta hai — itna zyada utaar chadhaw aapke risk comfort se match nahi karta.",
        'ur': "کرپٹو ایک ہی دن میں کافی اوپر یا نیچے جا سکتا ہے — اتنا زیادہ اتار چڑھاؤ آپ کے رسک کمفرٹ سے میل نہیں کھاتا۔",
    },
    'crypto_short_horizon': {
        'en': "You may need this money soon, and crypto can lose a large chunk of its value with little to no warning.",
        'ur_roman': "Aapko yeh paisa jald chahiye ho sakta hai, aur crypto apni value ka bara hissa bina zyada warning ke kho sakta hai.",
        'ur': "آپ کو یہ رقم جلد چاہیے ہو سکتی ہے، اور کرپٹو اپنی قیمت کا بڑا حصہ بغیر زیادہ وارننگ کے کھو سکتا ہے۔",
    },
    'crypto_emergency_fund': {
        'en': "Emergency savings need to stay stable and ready to use — crypto's sharp price swings make it the opposite of that.",
        'ur_roman': "Emergency savings ko stable aur foran istemal ke liye ready hona chahiye — crypto ke tez utaar chadhaw is ke bilkul ulat hain.",
        'ur': "ہنگامی بچت کو مستحکم اور فوری استعمال کے لیے تیار رہنا چاہیے — کرپٹو کا تیز اتار چڑھاؤ اس کے بالکل برعکس ہے۔",
    },
}

# ─────────────────────────────────────────────────────────────────────────────
# Deterministic scenario-specific advisory text (shown even for INCLUDED
# assets, when a caution is genuinely relevant to the user's specific
# answers). Independent of the hard-exclusion logic above.
# ─────────────────────────────────────────────────────────────────────────────

ADVISORY_TEXT = {
    'gold_emergency_or_short_horizon': {
        'en': "Gold is one of the safer picks here, but its price still moves week to week, and selling physical gold quickly may not get you that day's full market rate. Keep at least part of an emergency fund in something instantly liquid, like a savings account.",
        'ur_roman': "Sona yahan aik zyada mehfooz option hai, lekin iski qeemat hafta ba hafta harkat karti rehti hai, aur physical sona jaldi bechne par us din ki poori market rate na mile. Emergency fund ka kam az kam kuch hissa aisi jaga rakhein jo foran liquid ho, jaise savings account.",
        'ur': "سونا یہاں ایک زیادہ محفوظ آپشن ہے، لیکن اس کی قیمت ہفتہ بہ ہفتہ حرکت کرتی رہتی ہے، اور اصلی سونا جلدی بیچنے پر اس دن کی پوری مارکیٹ ریٹ نہ ملے۔ ہنگامی فنڈ کا کم از کم کچھ حصہ ایسی جگہ رکھیں جو فوری طور پر دستیاب ہو، جیسے سیونگز اکاؤنٹ۔",
    },
    'term_asset_short_horizon': {
        'en': "If you lock this money in and then need it back early, you'll typically lose some or all of the extra profit you would have earned — pick a tenure that truly matches when you'll need the money.",
        'ur_roman': "Agar aap yeh paisa lock kar dein aur phir jaldi wapis nikalna paray, to aam tor par kuch ya sara extra profit reh jata hai — aisi tenure chunein jo waqai us waqt se match kare jab aapko paisa chahiye ho.",
        'ur': "اگر آپ یہ رقم لاک کر دیں اور پھر جلدی واپس نکالنی پڑے، تو عام طور پر کچھ یا سارا اضافی منافع رہ جاتا ہے — ایسی مدت چنیں جو واقعی اس وقت سے میل کھائے جب آپ کو رقم چاہیے ہو۔",
    },
    'stocks_safe_risk_comfort': {
        'en': "Stocks are scored favorably for your timeline, but you told us you'd rather keep things safe — consider starting with a small amount, or leaning toward mutual funds where the ups and downs are spread across many companies.",
        'ur_roman': "Aapki timeline ke hisaab se stocks acha score karte hain, lekin aapne bataya ke aap cheezein mehfooz rakhna pasand karte hain — thori si raqam se shuru karne par ghor karein, ya mutual funds ki taraf jayein jahan utaar chadhaw kaee companies mein baant jata hai.",
        'ur': "آپ کے ٹائم لائن کے لحاظ سے اسٹاکس اچھا اسکور کرتے ہیں، لیکن آپ نے بتایا کہ آپ چیزیں محفوظ رکھنا پسند کرتے ہیں — تھوڑی سی رقم سے شروع کرنے پر غور کریں، یا میوچل فنڈز کی طرف جائیں جہاں اتار چڑھاؤ کئی کمپنیوں میں بٹ جاتا ہے۔",
    },
    'mutual_funds_safe_risk_comfort': {
        'en': "Within mutual funds, look for conservative or income-focused fund categories rather than equity/growth funds, since you told us you'd rather keep things safe.",
        'ur_roman': "Mutual funds mein, equity/growth funds ki bajaye conservative ya income-focused fund categories dekhein, kyunke aapne bataya ke aap cheezein mehfooz rakhna pasand karte hain.",
        'ur': "میوچل فنڈز میں، ایکویٹی/گروتھ فنڈز کی بجائے کنزرویٹیو یا انکم فوکسڈ فنڈ کیٹیگریز دیکھیں، کیونکہ آپ نے بتایا کہ آپ چیزیں محفوظ رکھنا پسند کرتے ہیں۔",
    },
    'crypto_volatility_reminder': {
        'en': "Even though your profile allows it, crypto stays the highest-risk option on this list by a wide margin — only use money you could fully afford to lose.",
        'ur_roman': "Agarche aapki profile ijazat deti hai, crypto phir bhi is list mein sab se zyada high-risk option hai — sirf wahi paisa istemal karein jise kho kar bhi aap poori tarah theek hon.",
        'ur': "اگرچہ آپ کی پروفائل اجازت دیتی ہے، کرپٹو پھر بھی اس فہرست میں سب سے زیادہ ہائی رسک آپشن ہے — صرف وہی رقم استعمال کریں جسے کھو کر بھی آپ مکمل طور پر ٹھیک ہوں۔",
    },
}


# ─────────────────────────────────────────────────────────────────────────────
# 6. Rule functions — pure Python, deterministic, no LLM / no I/O.
# ─────────────────────────────────────────────────────────────────────────────

# Suitability scores across the table range from -5 to 10 (see column stats
# verified against the source sheet). We normalize onto a common 0-100 scale
# so every asset's gauge is visually comparable on the frontend.
_SCORE_FLOOR = -5
_SCORE_CEIL = 10


def normalize_score(raw_score: int) -> int:
    """Maps a raw suitability score (-5..10) onto 0-100. Excluded (-99) -> 0."""
    if raw_score <= -99:
        return 0
    clamped = max(_SCORE_FLOOR, min(_SCORE_CEIL, raw_score))
    return round((clamped - _SCORE_FLOOR) / (_SCORE_CEIL - _SCORE_FLOOR) * 100)


def get_scenario_scores(experience: str, risk: str, horizon: str, goal: str, amount: str):
    """
    Looks up the exact row for these 5 answers in SCENARIO_TABLE.
    Returns a dict {asset_key: raw_score}. Raises KeyError if any answer
    isn't one of the 3 valid codes for its question (callers should validate
    against VALID_VALUES first and return a 400 rather than let this raise).
    """
    key = (experience, risk, horizon, goal, amount)
    raw_scores = SCENARIO_TABLE[key]
    return dict(zip(ASSET_KEYS, raw_scores))


def get_recommendation(experience: str, risk: str, horizon: str, goal: str, amount: str):
    """
    Full deterministic recommendation for one set of answers.

    Returns:
        {
          'top3': ['<asset_key>', '<asset_key>', '<asset_key>'],   # ranked #1..#3
          'excluded': ['<asset_key>', ...],                        # score == -99
          'scores': {asset_key: {'raw': int, 'suitability': 0-100}, ...},
        }

    top3/excluded are derived by sorting the 6 raw scores descending — this
    is mathematically identical to the Excel sheet's own "#1/#2/#3
    Recommended" and "Excluded" columns (verified against all 243 rows with
    zero mismatches), so there is exactly one source of truth: the score
    tuple in SCENARIO_TABLE.
    """
    raw_scores = get_scenario_scores(experience, risk, horizon, goal, amount)
    ranked = sorted(raw_scores.items(), key=lambda kv: -kv[1])

    top3 = [asset for asset, score in ranked[:3]]
    excluded = [asset for asset, score in ranked if score <= -99]

    scores = {
        asset: {'raw': score, 'suitability': normalize_score(score)}
        for asset, score in raw_scores.items()
    }

    return {'top3': top3, 'excluded': excluded, 'scores': scores}


def get_exclusion_reasons(asset_key: str, answers: dict):
    """
    answers: {'experience':.., 'risk':.., 'horizon':.., 'goal':.., 'amount':..}
    Returns a list of {'en':.., 'ur_roman':.., 'ur':..} reason objects that
    explain why `asset_key` was excluded for these answers. Empty list if the
    asset wasn't excluded, or has no specific reason mapped (shouldn't
    happen for stocks/mutual_funds/crypto, the only assets ever excluded).

    Purely rule-based — mirrors the exact boolean conditions that were
    verified against all 243 rows of SCENARIO_TABLE with zero mismatches:
      stocks excluded         <=>  experience == 'never' OR horizon == 'lt1' OR goal == 'emergency'
      mutual_funds excluded   <=>  goal == 'emergency'
      crypto excluded         <=>  NOT (experience == 'comfortable' AND risk == 'growth'
                                          AND horizon != 'lt1' AND goal != 'emergency')
    """
    reasons = []

    if asset_key == 'stocks':
        if answers['experience'] == 'never':
            reasons.append(EXCLUSION_REASON_TEXT['stocks_no_experience'])
        if answers['horizon'] == 'lt1':
            reasons.append(EXCLUSION_REASON_TEXT['stocks_short_horizon'])
        if answers['goal'] == 'emergency':
            reasons.append(EXCLUSION_REASON_TEXT['stocks_emergency_fund'])

    elif asset_key == 'mutual_funds':
        if answers['goal'] == 'emergency':
            reasons.append(EXCLUSION_REASON_TEXT['mutual_funds_emergency_fund'])

    elif asset_key == 'crypto':
        if answers['experience'] != 'comfortable':
            reasons.append(EXCLUSION_REASON_TEXT['crypto_experience'])
        if answers['risk'] != 'growth':
            reasons.append(EXCLUSION_REASON_TEXT['crypto_risk_comfort'])
        if answers['horizon'] == 'lt1':
            reasons.append(EXCLUSION_REASON_TEXT['crypto_short_horizon'])
        if answers['goal'] == 'emergency':
            reasons.append(EXCLUSION_REASON_TEXT['crypto_emergency_fund'])

    return reasons


def get_scenario_advisories(asset_key: str, answers: dict):
    """
    Returns a list of caution/advisory text objects for an INCLUDED asset,
    when the user's specific answers make a caution genuinely relevant
    (e.g. gold for a <1 year emergency fund, or a term deposit for someone
    who might need the money back early). Independent of the hard-exclusion
    rules above — an asset can be top-ranked and still carry an advisory.
    """
    advisories = []

    if asset_key == 'gold':
        if answers['goal'] == 'emergency' or answers['horizon'] == 'lt1':
            advisories.append(ADVISORY_TEXT['gold_emergency_or_short_horizon'])

    if asset_key in ('government_bonds', 'fixed_deposits'):
        if answers['horizon'] == 'lt1':
            advisories.append(ADVISORY_TEXT['term_asset_short_horizon'])

    if asset_key == 'stocks' and answers['risk'] == 'safe':
        advisories.append(ADVISORY_TEXT['stocks_safe_risk_comfort'])

    if asset_key == 'mutual_funds' and answers['risk'] == 'safe':
        advisories.append(ADVISORY_TEXT['mutual_funds_safe_risk_comfort'])

    if asset_key == 'crypto':
        advisories.append(ADVISORY_TEXT['crypto_volatility_reminder'])

    return advisories