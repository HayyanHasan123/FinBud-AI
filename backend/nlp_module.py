"""
BankAI - Conversational NLP Engine

Table-driven state machine with a global interceptor layer for multi-step
banking conversations: money transfer, bill payment, points redemption,
and emergency card blocking. A global interceptor handles emergency
pre-emption, cancellation, edit-previous-step, and contextual help before
any flow-specific logic runs.

`process_message()` is the public entrypoint. It returns a flat dict
(intent / entities / current_flow / awaiting_password / pending_entities
/ session_language / etc.) for the calling application to persist in
session state and render against localized response templates.
"""

import re
import unicodedata
from enum import Enum, auto
from dataclasses import dataclass, field
from typing import Callable, Optional, Any, Dict, List, Tuple
from llm_fallback import LLMFallback, apply_confidence_gate

# Fields that must never leak into logs or downstream payloads.
SENSITIVE_FIELDS = {'password'}


def scrub_sensitive_data(data_dict: dict) -> dict:
    """
    Recursively scrub a dictionary, replacing any string value whose key is in
    SENSITIVE_FIELDS with a redaction placeholder. Works on nested dicts and
    dicts nested inside lists. Returns a new dict; does not mutate the input.
    """
    if not isinstance(data_dict, dict):
        return data_dict

    scrubbed = {}
    for key, value in data_dict.items():
        if key in SENSITIVE_FIELDS and isinstance(value, str):
            scrubbed[key] = "[REDACTED]"
        elif isinstance(value, dict):
            scrubbed[key] = scrub_sensitive_data(value)
        elif isinstance(value, list):
            scrubbed[key] = [
                scrub_sensitive_data(item) if isinstance(item, dict) else item
                for item in value
            ]
        else:
            scrubbed[key] = value
    return scrubbed


def _scrub_context_for_log(ctx: dict) -> dict:
    """Convenience wrapper used internally whenever a context snapshot might
    be logged or echoed back - guarantees passwords never surface."""
    return scrub_sensitive_data(ctx or {})


class FlowState(Enum):
    IDLE = auto()
    TRANSFER_AWAIT_RECIPIENT = auto()
    TRANSFER_AWAIT_METHOD = auto()
    TRANSFER_AWAIT_IDENTIFIER = auto()
    TRANSFER_AWAIT_AMOUNT = auto()
    TRANSFER_AWAIT_PURPOSE = auto()
    TRANSFER_AWAIT_DESCRIPTION = auto()
    TRANSFER_AWAIT_CONFIRMATION = auto()
    TRANSFER_AWAIT_PASSWORD = auto()
    BILL_AWAIT_CATEGORY = auto()
    BILL_AWAIT_PROVIDER = auto()
    BILL_AWAIT_REFERENCE = auto()
    BILL_AWAIT_AMOUNT = auto()
    BILL_AWAIT_CONFIRMATION = auto()
    BILL_AWAIT_PASSWORD = auto()
    REDEEM_AWAIT_CHOICE = auto()
    REDEEM_AWAIT_PASSWORD = auto()
    EMERGENCY_AWAIT_PASSWORD = auto()
    EMERGENCY_AWAIT_CARD_SELECTION = auto()


# Map FlowState -> the legacy `current_flow` string app.py already persists
# in session['conversation_context']['current_flow']. Kept as a single
# source of truth so the new engine and the old session shape never drift.
FLOW_STATE_TO_LEGACY_FLOW = {
    FlowState.TRANSFER_AWAIT_RECIPIENT: 'transfer_money',
    FlowState.TRANSFER_AWAIT_METHOD: 'transfer_money',
    FlowState.TRANSFER_AWAIT_IDENTIFIER: 'transfer_money',
    FlowState.TRANSFER_AWAIT_AMOUNT: 'transfer_money',
    FlowState.TRANSFER_AWAIT_PURPOSE: 'transfer_money',
    FlowState.TRANSFER_AWAIT_DESCRIPTION: 'transfer_money',
    FlowState.TRANSFER_AWAIT_CONFIRMATION: 'transfer_money',
    FlowState.BILL_AWAIT_CATEGORY: 'pay_bill',
    FlowState.BILL_AWAIT_PROVIDER: 'pay_bill',
    FlowState.BILL_AWAIT_REFERENCE: 'pay_bill',
    FlowState.BILL_AWAIT_AMOUNT: 'pay_bill',
    FlowState.BILL_AWAIT_CONFIRMATION: 'pay_bill',
    FlowState.REDEEM_AWAIT_CHOICE: 'redeem_points',
}

# The ordered slot sequence for each flow: given a FlowState, this defines
# which slot is being filled and what state to move to once it's filled.
# Order matters - it's also what the edit-previous-step utility walks
# backwards over. This mirrors the fields collected by the app's
# transfer-money / pay-bill forms.
FLOW_SLOT_ORDER = {
    'transfer_money': [
        # 'recipient' is intentionally NOT a collected slot: the recipient's
        # name is never asked for or parsed from free text. It is resolved
        # automatically (via phone-number -> PostgreSQL lookup) as a
        # side-effect of filling 'transfer_identifier', and injected
        # straight into ctx['recipient'] at that point.
        'transfer_method', 'transfer_identifier',
        'amount', 'description',
    ],
    'pay_bill': ['bill_category', 'service_provider', 'bill_reference', 'amount'],
}

# State that immediately precedes "confirmation" for each flow - i.e. the
# state we land in once every data slot is filled.
FLOW_CONFIRMATION_STATE = {
    'transfer_money': FlowState.TRANSFER_AWAIT_CONFIRMATION,
    'pay_bill': FlowState.BILL_AWAIT_CONFIRMATION,
}

# State that corresponds to "currently collecting slot X" for each flow,
# keyed by (flow, slot_name). Used by the edit-previous-step utility to
# know which state to rewind into after clearing a slot.
FLOW_SLOT_STATE = {
    ('transfer_money', 'transfer_method'): FlowState.TRANSFER_AWAIT_METHOD,
    ('transfer_money', 'transfer_identifier'): FlowState.TRANSFER_AWAIT_IDENTIFIER,
    ('transfer_money', 'amount'): FlowState.TRANSFER_AWAIT_AMOUNT,
    # 'purpose' intentionally removed from the flow (no longer a collected
    # slot - see FLOW_SLOT_ORDER['transfer_money']); ctx['purpose'] is now
    # silently defaulted to 'Personal' instead of asked for. The
    # FlowState.TRANSFER_AWAIT_PURPOSE enum value itself is left defined
    # (unused) so nothing else that pattern-matches on the Enum breaks.
    ('transfer_money', 'description'): FlowState.TRANSFER_AWAIT_DESCRIPTION,
    ('pay_bill', 'bill_category'): FlowState.BILL_AWAIT_CATEGORY,
    ('pay_bill', 'service_provider'): FlowState.BILL_AWAIT_PROVIDER,
    ('pay_bill', 'bill_reference'): FlowState.BILL_AWAIT_REFERENCE,
    ('pay_bill', 'amount'): FlowState.BILL_AWAIT_AMOUNT,
}


@dataclass
class Slot:
    """Declarative description of a single piece of data a flow needs to
    collect. `extractor` pulls the value out of free text; `validator` (if
    given) additionally sanity-checks an extracted value before it's
    accepted. `on_missing_response_key` / `on_invalid_response_key` name the
    response-template keys to use when the slot can't be filled."""
    name: str
    extractor: Callable[[str], Optional[Any]]
    on_missing_response_key: str
    on_invalid_response_key: Optional[str] = None
    validator: Optional[Callable[[Any], bool]] = None


INTENT_PATTERNS = {
    # ── check_balance ────────────────────────────────────────────────────────
    'check_balance': [
        # Original Roman Urdu words (before slang substitution)
        r'\b(balance|kitna|kitni|baki|remaining)\b',
        r'\b(mere|mera|my)\s*(account|khata|khaata)\b',
        r'\b(show|dekha|batao|btao|check|dekho)\s*(balance|paisa|bakiya)\b',
        r'\bbalance\s*(check|dekh|batao|maloom)\b',
        r'\bkhata\s*(check|dekh|batao)\b',
        r'\bkhaata\s*(check|dekh|batao)\b',
        r'\b(rakam|raqam)\s*(batao|check|maloom)\b',
        # Normalized English equivalents (after slang substitution)
        r'\baccount\s*(check|balance|remaining)\b',
        r'\bmy\s*account\b',
        r'\bhow\s*much\s*(is\s*in|do\s*i\s*have|money|balance)\b',
        r'\bremaining\s*(balance|amount|money)\b',
        r'\bcheck\s*(my\s*)?balance\b',
        # Urdu script
        r'بیل[نی][سص]',
        r'بیل[نی][سص]\s*(بتا[وؤ]|چیک|دیکھ)',
        r'(میرا|مجھے)\s*(بیل[نی][سص]|بقیہ)',
        r'بقیہ\s*(بتا[وؤ]|دیکھ)',
        r'(دکھا[وؤ]|بتا[وؤ]|چیک\s*کر[وؤ])\s*بیل[نی][سص]',
        r'(اکاؤنٹ|کھاتہ)\s*(چیک|دیکھ)',
    ],

    # ── transfer_money ───────────────────────────────────────────────────────
    'transfer_money': [
        # Original Roman Urdu words
        r'\b(send|bhej|transfer|payment)\b',
        r'\b(pay|bhejo)\b.*\bto\b',
        r'\bpaisa[ey]?\s*(bhejo|bhej|transfer)\b',
        r'\bpaisy\s*(bhejo|bhej|transfer)\b',
        r'\btransfer\s*karo\b',
        r'\bmoney\s*(send|transfer)\b',
        r'\b(rakam|raqam)\s*(bhejo|bhej|transfer)\b',
        r'\b(paise|paisa|paisay|paisy)\s*(bhejna|bhejdo|bhej\s*do|transfer)\b',
        # Normalized English equivalents
        r'\bsend\s*money\b',
        r'\btransfer\s*amount\b',
        r'\bmoney\s*send\b',
        # Urdu script
        r'پیس[ےے]\s*(بھیج[وؤ]|ٹرانسفر)',
        r'رقم\s*(بھیج[وؤ]|ٹرانسفر\s*کر[وؤ])',
        r'(بھیج[وؤ]|بھیجنا|بھیج\s*دو)',
        r'ٹرانسفر\s*کر[وؤ]',
        r'(کو|کے\s*لیے)\s*پیس[ےے]\s*(بھیج|دے)',
    ],

    # ── pay_bill ─────────────────────────────────────────────────────────────
    'pay_bill': [
        # Original Roman Urdu words
        r'\b(bill|bijli|bijlee|bjili|bijly|pani|paani|gas|sui\s*gas|suigas|sui\s*gais)\b',
        r'\b(electricity|k-electric|lesco|ptcl)\b',
        r'\bbill\s*(pay|karo|karna|ada|bharo)\b',
        r'\b(bijli|bijlee|bjili|bijly|sui\s*gas|pani|paani)\s*ka\s*bill\b',
        r'\b(k-electric|lesco|ptcl|gas)\s*(ka\s*)?(bills?)\b',
        r'\bpay\s*(my\s*)?bills?\b',
        r'\butility\s*bills?\b',
        r'\bbilling\b',
        # Normalized English equivalents
        r'\belectricity\s*(bill|pay|ka)?\b',
        r'\bwater\s*(bill|pay|ka)?\b',
        r'\bgas\s*(bill|pay|ka)?\b',
        r'\bpay\s*(electricity|water|gas|internet)\b',
        # Urdu script
        r'بل\s*(ادا\s*کر[وؤ]|جمع\s*کر[وؤ]|بھر[وؤ]|pay)',
        r'(بجلی|گیس|پانی|انٹرنیٹ)\s*(کا\s*)?بل',
        r'(k-electric|lesco|ptcl|sui\s*گیس)\s*(کا\s*)?بل',
        r'یوٹیلیٹی\s*بل',
    ],

    # ── transaction_history ──────────────────────────────────────────────────
    'transaction_history': [
        # Original Roman Urdu words
        r'\b(history|transactions?|statement)\b',
        r'\b(last|pichle|pichli)\s*transactions?\b',
        r'\btarikh\b',
        r'\b(lain\s*dain|len\s*den)\b',
        r'\braseed\b',
        r'\bpichle\b',
        # Normalized English equivalents (raseed→receipt, tarikh→history)
        r'\breceipt\b',
        r'\b(show|display|check)\s*(my\s*)?(history|transactions?|statement)\b',
        r'\brecent\s*(transactions?|history)\b',
        r'\bmy\s*(transactions?|history|statement)\b',
        # Urdu script
        r'لین\s*دین',
        r'(پچھلے|گزشتہ)\s*(ٹرانزیکشن|لین\s*دین)',
        r'اکاؤنٹ\s*(سٹیٹمنٹ|تاریخ)',
        r'رسید',
    ],

    # ── redeem_points  (checked BEFORE check_rewards — more specific) ────────
    'redeem_points': [
        # Original Roman Urdu words
        r'\bredeem\s*(my\s*|your\s*)?(points?|rewards?)\b',
        r'\b(use|exchange)\s*(my\s*|your\s*)?points?\b',
        r'\bpoints?\s*(redeem|use)\b',
        r'\bpoints?\s*(use\s*karna|use\s*karo|exchange\s*karo)\b',
        # Urdu script (ئ / ي both covered post-diacritic-strip)
        r'پوا[\u0626\u064A]نٹس?\s*(استعمال|ریڈیم|ریڈیم\s*کر[وؤ])',
        r'(میرے|اپنے)\s*پوا[\u0626\u064A]نٹس?\s*(استعمال|ریڈیم)',
    ],

    # ── check_rewards ────────────────────────────────────────────────────────
    'check_rewards': [
        # Original Roman Urdu words
        r'\b(reward|points?)\b',
        r'\b(mere|my)\s*points?\b',
        r'\bkitne\s*(points?|rewards?)\b',
        r'\bpoints?\s*kitne\b',
        r'\bpoints?\s*(check|batao|dekho|maloom|hain|hai)\b',
        # Normalized English equivalents
        r'\bhow\s*(many|much)\s*(points?|rewards?)\b',
        r'\bcheck\s*(my\s*)?(points?|rewards?)\b',
        r'\b(my\s*)?(points?|rewards?)\s*(balance|count|total)\b',
        # Urdu script
        r'(میرے|کتنے)\s*پوا[\u0626\u064A]نٹس?',
        r'(انعام|ریوارڈ)\s*(چیک|بتا[وؤ]|دیکھ)',
        r'پوا[\u0626\u064A]نٹس?\s*(کتنے|باقی|بتا[وؤ])',
    ],

    # ── bill_reminders ───────────────────────────────────────────────────────
    'bill_reminders': [
        # Original Roman Urdu words
        r'\b(reminder|yaad)\b',
        r'\b(upcoming|pending|baki)\s*bills?\b',
        r'\bshow\b.*\bbills?\b',
        r'\bbatao\b.*\bbills?\b',
        r'\bbill\s*(reminder|yaad\s*dilao)\b',
        r'\bmy\s*bills?\b',
        # Normalized equivalents (yaad→reminder, baki→remaining)
        r'\breminder\b',
        r'\bpending\s*(payments?|dues?|bills?)\b',
        r'\bshow.*pending\b',
        # Urdu script
        r'(آنے\s*والے|زیر\s*التوا)\s*بل',
        r'بل\s*(یادہانی|یاد\s*دلا[وؤ])',
        r'(پنڈنگ|باقی)\s*بل',
    ],

    # ── emergency ────────────────────────────────────────────────────────────
    'emergency': [
        # Original Roman Urdu words
        r'\b(block|lock|band)\s*(card|my\s*card)\b',
        r'\bcard\s*(block|lock|band)\s*karo\b',
        r'\bmere\s*card\s*(block|lock|band)\b',
        r'\bemergency\b',
        r'\b(chori|gum|churaya|khoya)\b',
        r'\bcard\s*(gum|khoya|chori)\b',
        r'\b(fraud|unauthorized)\b',
        # Normalized English equivalents (chori→theft, gum→lost, churaya→stolen)
        r'\b(theft|stolen|lost)\b',
        r'\bcard\s*(theft|stolen|lost|block|lock)\b',
        r'\b(block|lock)\s*(my\s*)?card\b',
        # Plural / "all"-in-between phrasing (e.g. "lock all my cards",
        # "block all cards") — the singular-only patterns above don't
        # cover this, and it needs to still be recognised as a (now
        # multi-card) emergency intent, not just as the separate
        # EMERGENCY_ALL_CARDS_PATTERNS all-cards flag.
        r'\b(block|lock|band)\s*(all\s*)?(my\s*)?cards\b',
        r'\bsaare\s*cards?\s*(block|lock|band)',
        r'\bsab\s*cards?\s*(block|lock|band)',
        # Urdu script
        r'کارڈ\s*(بلاک|لاک|بند)\s*(کر[وؤ])?',
        r'(تمام|سارے)\s*کارڈز\s*(بلاک|لاک|بند)',
        r'(کارڈ\s*چوری|کارڈ\s*گم)',
        r'(ایمرجنسی|فوری)',
        r'غیر\s*مجاز\s*(ٹرانزیکشن|لین\s*دین)',
    ],
    # ── human_agent ──────────────────────────────────────────────────────────
    'human_agent': [
        # Original Roman Urdu words
        r'\b(human|person|agent)\b',
        r'\bkisi\s*se\s*baat\b',
        r'\b(customer\s*service|support|helpline)\b',
        r'\b(baat\s*karni|baat\s*karo)\b',
        # Urdu script
        r'(انسان|ایجنٹ|نمائندہ)\s*(سے\s*بات|چاہیے)',
        r'کسٹمر\s*(سروس|سپورٹ)',
        r'کسی\s*سے\s*بات',
    ],
}

# Explicit "lock ALL my cards" phrasing - a deliberate power-user path that
# stays available even once the account has 2+ cards (in which case the
# generic 'emergency' patterns above trigger the "which card?" selection
# step instead). Checked separately from INTENT_PATTERNS['emergency'] so
# the all-cards path can be detected without changing what counts as an
# emergency intent in the first place.
EMERGENCY_ALL_CARDS_PATTERNS = [
    r'\ball\s*(of\s*)?my\s*cards\b',
    r'\ball\s*cards\b',
    r'\bsaare\s*cards\b',
    r'\bsab\s*cards\b',
    r'\bharek\s*card\b',
    # Urdu script
    r'تمام\s*کارڈز',
    r'سارے\s*کارڈز',
]

# Global cancel patterns - checked on every turn, regardless of
# active flow, before any slot extraction happens.
CANCEL_PATTERNS = [
    r'^\s*cancel\s*$',
    r'^\s*stop\s*$',
    r'^\s*ruko\s*$',
    r'\bruko\b',
    r'\brok\s*do\b',
    r'\bcancel\s*(it|this|transaction|transfer)\b',
    r'\bnever\s*mind\b',
    r'\bnevermind\b',
    r'\bchore?d?o?\s*do\b',  # "chor do" - leave it / drop it
    r'\bband\s*kar\s*do\b(?!\s*card)',  # "band kar do" (stop), but NOT "band kar do card" (card-block emergency)
]

# Edit-previous-step trigger patterns.
EDIT_PREVIOUS_PATTERNS = [
    r'\bactually\b',
    r'\bgo\s*back\b',
    r'\bchange\s*(it|that|amount|recipient|name)\b',
    r'\bwait\s*,?\s*make\s*it\b',
    r'\bno\s*,?\s*wait\b',
    r'\boh\s*,?\s*wait\b',
    r'\bhold\s*on\b',
    r'\bi\s*meant\b',
    r'\bmeant\s*to\s*say\b',
    r'\bsorry\s*,?\s*i\s*meant\b',
    r'\bnot\s*that\s*,?\s*i\s*(want|need)\b',
    r'\bthat\'?s\s*wrong\b',
    r'\binstead\b',
    r'\bedit\b',
    r'\bcorrection\b',
    r'\bgalat\s*(tha|hai)\b',  # "galat tha/hai" - that was wrong
    r'\bpeeche\s*jao\b',       # "peeche jao" - go back
    r'\bnahi\s*,?\s*woh\b',    # "nahi, woh..." - no, that.../the other one
    r'\bghalti\s*se\b',        # "ghalti se" - by mistake
]

# Contextual help trigger patterns.
HELP_PATTERNS = [
    r'^\s*help\s*$',
    r'\bwhat\s*(do|can)\s*i\s*(do|type|say)\b',
    r'\bmadad\b',
    r'\bhow\s*does\s*this\s*work\b',
    r'^\s*\?\s*$',
]

# Affirmative / negative responses for the confirmation step.
AFFIRMATIVE_PATTERNS = [
    r'^\s*yes\s*$', r'^\s*y\s*$', r'^\s*yeah\s*$', r'^\s*yep\s*$',
    r'^\s*confirm(ed)?\s*$', r'^\s*ok(ay)?\s*$', r'^\s*haan\s*(ji)?\s*$',
    r'^\s*ji\s*haan\s*$', r'^\s*ji\s*$', r'^\s*g\s*$', r'^\s*sahi\s*hai\s*$',
    r'^\s*theek\s*hai\s*$', r'^\s*proceed\s*$',
    # Urdu script equivalents (glyph forms match existing RESPONSES strings
    # in this file, e.g. line ~530/595's "بالکل"/"ٹھیک ہے").
    r'^\s*ہاں\s*(جی)?\s*$', r'^\s*جی\s*ہاں\s*(بالکل)?\s*$', r'^\s*جی\s*$',
    r'^\s*ٹھیک\s*(ہے)?\s*$', r'^\s*بالکل\s*$',
    r'^\s*درست\s*(ہے)?\s*$', r'^\s*صحیح\s*(ہے)?\s*$',
]
NEGATIVE_PATTERNS = [
    r'^\s*no\s*$', r'^\s*n\s*$', r'^\s*nah\s*$', r'^\s*nahi\s*n?\s*$',
    r'^\s*nope\s*$', r'^\s*cancel\s*$', r'^\s*galat\s*$',
    # Urdu script equivalents.
    r'^\s*نہیں\s*(جی)?\s*$', r'^\s*جی\s*نہیں\s*$', r'^\s*نہ\s*$',
    r'^\s*غلط\s*$', r'^\s*منسوخ\s*$', r'^\s*کینسل\s*$', r'^\s*رک\s*جاؤ\s*$',
]

# ── SLANG_MAPPING ─────────────────────────────────────────────────────────
# Maps Roman Urdu / local phonetic variants → canonical English equivalents.
# CRITICAL: entity extractors (names, account numbers, amounts) operate on
# the ORIGINAL user text, never on slang-substituted text. See the
# normalization pipeline below for the two-track (display vs. match) design.
SLANG_MAPPING = {
    # Electricity / bijli phonetic bucket
    'bijli': 'electricity',
    'bjili': 'electricity',
    'bijly': 'electricity',
    'bijlee': 'electricity',
    'bijlee': 'electricity',
    'bijaly': 'electricity',
    # Water / pani
    'pani': 'water',
    'paani': 'water',
    'paane': 'water',
    # Gas
    'sui gas': 'gas',
    'suigas': 'gas',
    'sui gais': 'gas',
    # Send / transfer verbs — bhej* family
    'bhejo': 'send',
    'bhej': 'send',
    'bhej do': 'send',
    'bhejdo': 'send',
    'bhejna': 'send',
    'bhejein': 'send',
    'bhejiye': 'send',
    'bhejna hai': 'send',
    # How much / quantity
    'kitna': 'how much',
    'kitne': 'how many',
    'ketna': 'how much',
    'ketne': 'how many',
    'kitnay': 'how many',
    # Possessive
    'mere': 'my',
    'mera': 'my',
    'mery': 'my',
    'meri': 'my',
    # Money / amount
    'paisa': 'money',
    'paise': 'money',
    'paisy': 'money',
    'paisay': 'money',
    'paisaa': 'money',
    'rakam': 'amount',
    'raqam': 'amount',
    # Currency
    'rupay': 'rupees',
    'rupaye': 'rupees',
    'rupaya': 'rupees',
    'rupye': 'rupees',
    'rupaiye': 'rupees',
    # Account
    'khata': 'account',
    'khaata': 'account',
    'khatta': 'account',
    # Reminder
    'yaad': 'reminder',
    'yad': 'reminder',
    'yaad dilao': 'reminder',
    # Remaining / balance
    'baki': 'remaining',
    'baqi': 'remaining',
    # Action verbs
    'karo': 'do',
    'kro': 'do',
    'karna': 'do',
    'krna': 'do',
    'kardo': 'do',
    'kar do': 'do',
    'kijiye': 'do',
    'karein': 'do',
    # Tell / show
    'batao': 'tell',
    'btao': 'tell',
    'batain': 'tell',
    'batana': 'tell',
    'dikhaiye': 'show',
    'dikha': 'show',
    'dekho': 'show',
    'dekhain': 'show',
    # Block / lock
    'band': 'lock',
    'bnd': 'lock',
    # Pay
    'ada': 'pay',
    'adaa': 'pay',
    'ada karo': 'pay',
    'bharo': 'pay',
    # Check / find out
    'maloom': 'check',
    'pata': 'check',
    'pata karo': 'check',
    'maloom karo': 'check',
    # Transfer / send (alternative)
    'transfer karo': 'transfer',
    'transfer karein': 'transfer',
    # Receipt / history
    'raseed': 'receipt',
    'tarikh': 'history',
    'tarikhi': 'history',
    # Emergency / theft
    'chori': 'theft',
    'churaya': 'stolen',
    'gum': 'lost',
    'khoya': 'lost',
    # Utility
    'utility': 'utility',
    'bijli ka bill': 'electricity bill',
    'pani ka bill': 'water bill',
    # Greeting
    'salam': 'hello',
    'assalam': 'hello',
    'aoa': 'hello',
}

RESPONSES = {
    'greeting': {
        'en': "Hi there! I'm FinBud AI — happy to help. What can I do for you today?",
        'ur': "السلام علیکم! میں FinBud AI ہوں۔ میں آپ کی کیسے مدد کر سکتا ہوں؟",
        'ru': "Assalam-o-Alaikum! Main FinBud AI hoon, aapki khidmat mein hazir hoon. Aaj main aapki kaise madad kar sakta hoon?"
    },
    'unknown': {
        'en': "I didn't understand that. Try:\n• Check balance\n• Send money\n• Pay bills",
        'ur': "معذرت، میں سمجھ نہیں سکا",
        'ru': "Maafi, main samajh nahi saka. Try karein:\n• Balance check karein\n• Paisa bhejein\n• Bill pay karein"
    },
    'check_balance': {
        'en': "Your balance is RS {balance:,}",
        'ur': "آپ کا بیلنس \u2066RS {balance:,}\u2069 ہے",
        'ru': "Aap ka balance RS {balance:,} hai"
    },
    'transfer_ask_method': {
        'en': "Sure thing! How would you like to send the money — IBAN, Account Number, or Raast ID?",
        'ur': "🏦 بالکل! آپ کس طریقے سے پیسے بھیجنا چاہتے ہیں؟ IBAN، Account Number، یا Raast ID میں سے چنیں۔",
        'ru': "🏦 Bilkul! Aap kis tareeqe se paisa bhejna chahenge — IBAN, Account Number, ya Raast ID?"
    },
    'transfer_method_invalid': {
        'en': "❌ Sorry, I didn't quite catch that. Could you reply with one of: IBAN, Account Number, or Raast ID?",
        'ur': "❌ معذرت، یہ سمجھ نہیں آیا۔ براۓ کرم ان میں سے کوئی ایک لکھیں: IBAN، Account Number، یا Raast ID۔",
        'ru': "❌ Maaf karein, yeh samajh nahi aaya. In mein se koi ek batayein: IBAN, Account Number, ya Raast ID."
    },
    'transfer_ask_identifier': {
        'en': "📱 Great — what's the recipient's registered phone number (e.g. 03XXXXXXXXX)? We'll look up their FinBud-AI account automatically.",
        'ur': "📱 بہت خوب — وصول کنندہ کا رجسٹرڈ فون نمبر بتائیں (مثلاً 03XXXXXXXXX)۔ ہم خودکار طور پر ان کا FinBud-AI اکاؤنٹ تلاش کر لیں گے۔",
        'ru': "📱 Behtareen — recipient ka registered phone number kya hai (e.g. 03XXXXXXXXX)? Hum unka FinBud-AI account khud dhoond lenge."
    },
    'transfer_invalid_identifier': {
        'en': "❌ Hmm, that doesn't look like a valid Pakistani phone number. Please try entering it as 03XXXXXXXXX or +923XXXXXXXXX.",
        'ur': "❌ یہ درست پاکستانی فون نمبر نہیں لگتا۔ براۓ کرم 03XXXXXXXXX یا +923XXXXXXXXX کی صورت میں درج کریں۔",
        'ru': "❌ Yeh sahi Pakistani phone number nahi lag raha. Zara 03XXXXXXXXX ya +923XXXXXXXXX ki soorat mein dobara try karein."
    },
    'transfer_ask_identifier_iban': {
        'en': "🏦 Please share the recipient's IBAN. A Pakistani IBAN is 24 characters: 'PK' + 2 digits + 4-letter bank code + 16 digits (e.g. PK36SCBL0000001123456702).",
        'ur': "🏦 براۓ کرم وصول کنندہ کا IBAN بتائیں۔ پاکستانی IBAN 24 حروف کا ہوتا ہے: 'PK' + 2 ہندسے + بینک کوڈ + 16 ہندسے (مثلاً PK36SCBL0000001123456702)۔",
        'ru': "🏦 Recipient ka IBAN share karein. Pakistani IBAN 24 characters ka hota hai: 'PK' + 2 digits + bank code + 16 digits (e.g. PK36SCBL0000001123456702)."
    },
    'transfer_invalid_identifier_iban': {
        'en': "❌ That doesn't quite look like a valid IBAN. A Pakistani IBAN is 24 characters: 'PK' + 2 digits + 4-letter bank code + 16 digits (e.g. PK36SCBL0000001123456702).",
        'ur': "❌ یہ درست IBAN نہیں لگتا۔ پاکستانی IBAN 24 حروف کا ہوتا ہے: 'PK' + 2 ہندسے + بینک کوڈ + 16 ہندسے (مثلاً PK36SCBL0000001123456702)۔",
        'ru': "❌ Yeh sahi IBAN nahi lag raha. Pakistani IBAN 24 characters ka hota hai: 'PK' + 2 digits + bank code + 16 digits (e.g. PK36SCBL0000001123456702)."
    },
    'transfer_ask_identifier_account': {
        'en': "🏦 What's the recipient's account number? (8-16 digits, numbers only)",
        'ur': "🏦 وصول کنندہ کا اکاؤنٹ نمبر بتائیں (8-16 ہندسے، صرف نمبر)۔",
        'ru': "🏦 Recipient ka account number kya hai? (8-16 digits, sirf numbers)"
    },
    'transfer_invalid_identifier_account': {
        'en': "❌ That doesn't look like a valid account number. Could you enter 8-16 digits only?",
        'ur': "❌ یہ درست اکاؤنٹ نمبر نہیں لگتا۔ براۓ کرم صرف 8-16 ہندسے درج کریں۔",
        'ru': "❌ Yeh sahi account number nahi lag raha. Sirf 8-16 digits darj karein."
    },
    'transfer_recipient_found': {
        'en': "✅ Found it! There's a FinBud-AI account for {name}. Should we send this transfer to {name}? (yes/no)",
        'ur': "✅ مل گیا! \u2066{name}\u2069 کا FinBud-AI اکاؤنٹ موجود ہے۔ کیا یہ ٹرانسفر \u2066{name}\u2069 کو بھیجیں؟ (yes/no)",
        'ru': "✅ Mil gaya! {name} ka FinBud-AI account mojood hai. Kya yeh transfer {name} ko bhejein? (yes/no)"
    },
    'transfer_ask_recipient_name': {
        'en': "👤 This account is outside FinBud-AI, so we can't verify it automatically. Could you type the recipient's full name for the transfer?",
        'ur': "👤 چونکہ یہ اکاؤنٹ FinBud-AI کے باہر کا ہے، ہم خودکار طور پر تصدیق نہیں کر سکتے۔ براۓ کرم وصول کنندہ کا پورا نام لکھیں۔",
        'ru': "👤 Yeh account FinBud-AI ke bahar ka hai, is liye hum automatically verify nahi kar sakte. Recipient ka pura naam bata dein."
    },
    'transfer_phone_not_found': {
        'en': "❌ We couldn't find a registered FinBud-AI account for this phone number. Please double-check it and try again.",
        'ur': "❌ اس فون نمبر سے منسلک کوئی رجسٹرڈ FinBud-AI اکاؤنٹ نہیں ملا۔ براۓ کرم نمبر چیک کریں اور دوبارہ کوشش کریں۔",
        'ru': "❌ Is phone number se koi registered FinBud-AI account nahi mila. Number dobara check karke try karein."
    },
    'transfer_identifier_wrong_format': {
        'en': "❌ That doesn't look like a valid {transfer_method}. Could you enter it in the correct format for {transfer_method}?",
        'ur': "❌ یہ درست \u2066{transfer_method}\u2069 نہیں لگتا۔ براۓ کرم \u2066{transfer_method}\u2069 کے درست فارمیٹ میں درج کریں۔",
        'ru': "❌ Yeh sahi {transfer_method} nahi lag raha. Correct format mein {transfer_method} enter karein."
    },
    'transfer_account_not_found': {
        'en': "❌ That account number doesn't seem to be coming up — could you double-check it and enter it again?",
        'ur': "❌ یہ اکاؤنٹ نمبر درست نہیں لگتا — ہمیں یہ نہیں ملا۔ براۓ کرم دوبارہ چیک کر کے درج کریں۔",
        'ru': "❌ Yeh account number theek nahi mil raha — zara dobara check karke enter karein."
    },
    'transfer_ask_amount': {
        'en': "Got it! How much would you like to send to {recipient}?",
        'ur': "💰 \u200Fٹھیک ہے! آپ \u2066{recipient}\u2069 کو کتنی رقم بھیجنا چاہتے ہیں؟",
        'ru': "Theek hai! Aap {recipient} ko kitni raqam bhejna chahenge?"
    },
    'transfer_ask_purpose': {
        'en': "What's the purpose of this transfer? (Rent, Salary, Business, Personal, or Other)",
        'ur': "📋 اس ٹرانسفر کا مقصد کیا ہے؟ (Rent، Salary، Business، Personal، یا Other)",
        'ru': "Is transfer ka purpose kya hai? (Rent, Salary, Business, Personal, ya Other)"
    },
    'transfer_ask_description': {
        'en': "Almost done! Want to tag this transfer with a category (e.g. Grocery, Rent, Utility Bills)? Just say \"skip\" and we'll file it as \"Transfer\".",
        'ur': "کیا اس ٹرانسفر کے لیے کوئی مخصوص کیٹیگری ہے؟ چھوڑنے کے لیے \"skip\" لکھیں۔",
        'ru': "Bus thodi der aur! Is transfer ko koi category dena chahenge (maslan Grocery, Rent)? Chhorne ke liye bas \"skip\" likh dein."
    },
    'transfer_confirm': {
        'en': "Alright, here's what I've got: sending RS {amount:,} to {recipient} via {transfer_method} ({transfer_identifier}) for {purpose} [{description}]. Shall I go ahead? (yes/no)",
        'ur': "\u200Fتصدیق کریں: \u2066RS {amount:,}\u2069 \u2066{recipient}\u2069 کو \u2066{transfer_method}\u2069 (\u2066{transfer_identifier}\u2069) کے ذریعے، \u2066{purpose}\u2069 [\u2066{description}\u2069] کے لیے بھیجنا ہے — yes/no؟",
        'ru': "Theek hai, yeh raha summary: RS {amount:,} {recipient} ko {transfer_method} ({transfer_identifier}) ke zariye, {purpose} [{description}] ke liye. Aage badhein? (yes/no)"
    },
    'transfer_password_request': {
        'en': "🔒 Almost there! Please enter your password to confirm sending RS {amount:,} to {recipient}.",
        'ur': "🔒 \u200Fبراۓ کرم اپنا پاس ورڈ درج کریں تاکہ \u2066{recipient}\u2069 کو \u2066RS {amount:,}\u2069 کی منتقلی کی تصدیق ہو سکے۔",
        'ru': "🔒 Bas ek aakhri kadam! Apna password enter karein taake {recipient} ko RS {amount:,} ki transfer confirm ho sake."
    },
    'transfer_success': {
        'en': "✅ All done! RS {amount:,} sent to {recipient}.\n💰 New balance: RS {balance:,}\n⭐ You earned {points} reward points!",
        'ur': "✅ \u200Fٹرانسفر کامیاب! \u2066RS {amount:,}\u2069 \u2066{recipient}\u2069 کو بھیجا گیا۔\n💰 \u200Fنیا بیلنس: \u2066RS {balance:,}\u2069\n⭐ \u200Fآپ نے \u2066{points}\u2069 انعامی پوائنٹس حاصل کیے!",
        'ru': "✅ Ho gaya! RS {amount:,} {recipient} ko bheja gaya.\n💰 Naya balance: RS {balance:,}\n⭐ Aap ne {points} reward points hasil kiye!"
    },
    'bill_ask_category': {
        'en': "Sure! Which bill would you like to pay?\n• Electricity\n• Gas\n• Internet",
        'ur': "📋 آپ کون سا بل ادا کرنا چاہتے ہیں؟\n• بجلی\n• گیس\n• انٹرنیٹ",
        'ru': "Bilkul! Aap konsa bill pay karna chahenge?\n• Electricity\n• Gas\n• Internet"
    },
    'bill_ask_provider': {
        'en': "Which provider would that be — {provider_hint}?",
        'ur': "🏢 کون سا پرووائیڈر - {provider_hint}؟",
        'ru': "Konsa provider hoga — {provider_hint}?"
    },
    'bill_ask_reference': {
        'en': "Great, could you share your {bill_category} bill reference number? (digits only)",
        'ur': "🔢 براۓ کرم اپنا {bill_category} بل ریفرنس نمبر فراہم کریں (صرف نمبر)۔",
        'ru': "Theek hai, apna {bill_category} ka bill reference number bata dein (sirf numbers)."
    },
    'bill_reference_invalid': {
        'en': "❌ That doesn't look like a valid reference number. Please enter digits only (found on your bill statement).",
        'ur': "❌ یہ درست ریفرنس نمبر نہیں لگتا۔ براۓ کرم صرف نمبر درج کریں (جو آپ کے بل سٹیٹمنٹ پر موجود ہے)۔",
        'ru': "❌ Yeh sahi reference number nahi lagta. Sirf numbers (digits) mein likhein, jo aapke bill statement par hota hai."
    },
    'bill_ask_amount': {
        'en': "And how much is the {bill_category} bill for?",
        'ur': "💵 آپ کا {bill_category} بل کتنا ہے؟",
        'ru': "Aur {bill_category} bill kitna hai?"
    },
    'bill_confirm': {
        'en': "Here's the summary: paying RS {amount:,} to {service_provider} for your {bill_category} bill (ref {bill_reference}). Good to go? (yes/no)",
        'ur': "تصدیق کریں: \u2066{service_provider}\u2069 کو {bill_category} بل (ریف \u2066{bill_reference}\u2069) کے لیے \u2066RS {amount:,}\u2069 ادا کرنا ہے — yes/no؟",
        'ru': "Yeh raha summary: {service_provider} ko {bill_category} bill (ref {bill_reference}) ke liye RS {amount:,} pay karna hai. Theek hai? (yes/no)"
    },
    'bill_payment_password_request': {
        'en': "🔒 Just your password left! Please enter it to confirm the {bill_category} bill payment of RS {amount:,} to {service_provider}.",
        'ur': "🔒 براۓ کرم اپنا پاس ورڈ درج کریں تاکہ \u2066{service_provider}\u2069 کو {bill_category} بل \u2066RS {amount:,}\u2069 کی ادائیگی کی تصدیق ہو سکے۔",
        'ru': "🔒 Bas password reh gaya hai! Apna password enter karein taake {service_provider} ko {bill_category} bill RS {amount:,} ki payment confirm ho sake."
    },
    'bill_payment_success': {
        'en': "✅ All set! {bill_type} bill of RS {amount:,} paid.\n💰 New balance: RS {balance:,}\n⭐ You earned {points} reward points!",
        'ur': "✅ بل ادائیگی کامیاب! {bill_type} بل \u2066RS {amount:,}\u2069 ادا کیا گیا۔\n💰 نیا بیلنس: \u2066RS {balance:,}\u2069\n⭐ آپ نے \u2066{points}\u2069 انعامی پوائنٹس حاصل کیے!",
        'ru': "✅ Ho gaya! {bill_type} bill RS {amount:,} ada kiya gaya.\n💰 Naya balance: RS {balance:,}\n⭐ Aap ne {points} reward points hasil kiye!"
    },
    'check_rewards': {
        'en': "You have {points} reward points",
        'ur': "آپ کے پاس {points} انعامی پوائنٹس ہیں",
        'ru': "Aap ke paas {points} reward points hain"
    },
    'redeem_password_request': {
        'en': "🔒 Please enter your password to confirm points redemption.",
        'ur': "🔒 براۓ کرم اپنا پاس ورڈ درج کریں تاکہ پوائنٹس ریڈیمپشن کی تصدیق ہو سکے۔",
        'ru': "🔒 Apna password enter karein taake points redemption confirm ho sake."
    },
    'redeem_success': {
        'en': "✅ Redemption successful! {points_used} points redeemed for RS {reward_value}.\n💰 New balance: RS {balance:,}\n⭐ Remaining points: {remaining_points}",
        'ur': "✅ ریڈیمپشن کامیاب! \u2066{points_used}\u2069 پوائنٹس \u2066RS {reward_value}\u2069 کے لیے استعمال کیے گئے۔\n💰 نیا بیلنس: \u2066RS {balance:,}\u2069\n⭐ باقی پوائنٹس: \u2066{remaining_points}\u2069",
        'ru': "✅ Redemption kamyab! {points_used} points RS {reward_value} ke liye use kiye gaye.\n💰 Naya balance: RS {balance:,}\n⭐ Baqi points: {remaining_points}"
    },
    'bill_reminders': {
        'en': "Your pending bills",
        'ur': "آپ کے التواء میں بل",
        'ru': "Aap ke pending bills"
    },
    'transaction_history': {
        'en': "Your recent transactions",
        'ur': "آپ کے حالیہ لین دین",
        'ru': "Aap ke recent transactions"
    },
    'clarify_redemption_option': {
        'en': "Which reward would you like to redeem?\n1. PKR 500 Cash Voucher (1,000 Points)\n2. PKR 250 Bill Discount (500 Points)",
        'ur': "آپ کون سا انعام حاصل کرنا چاہتے ہیں؟\n1. PKR 500 کیش واؤچر (1,000 پوائنٹس)\n2. PKR 250 بل ڈسکاؤنٹ (500 پوائنٹس)",
        'ru': "Aap konsa reward lena chahte hain?\n1. PKR 500 Cash Voucher (1,000 Points)\n2. PKR 250 Bill Discount (500 Points)"
    },
    'emergency_password_request': {
        'en': "⚠️ SECURITY CHECK: Please enter your password to confirm card blocking.",
        'ur': "⚠️ سیکیورٹی چیک: براۓ کرم اپنا پاس ورڈ درج کریں تاکہ کارڈ بلاک کرنے کی تصدیق ہو سکے۔",
        'ru': "⚠️ SECURITY CHECK: Apna password enter karein taake card block confirm ho sake."
    },
    'emergency_password_incorrect': {
        'en': "❌ Incorrect password. You have {attempts} attempt(s) remaining. Please try again.",
        'ur': "❌ غلط پاس ورڈ۔ آپ کے پاس \u2066{attempts}\u2069 کوشش(یں) باقی ہیں۔ براۓ کرم دوبارہ کوشش کریں۔",
        'ru': "❌ Ghalat password. Aap ke paas {attempts} koshish(ain) baqi hain. Dobara koshish karein."
    },
    'emergency_failed': {
        'en': "❌ Emergency mode failed. Too many incorrect password attempts. Please contact customer support.",
        'ur': "❌ ایمرجنسی موڈ ناکام۔ بہت زیادہ غلط پاس ورڈ کی کوششیں۔ براۓ کرم کسٹمر سپورٹ سے رابطہ کریں۔",
        'ru': "❌ Emergency mode nakam. Bahut zyada ghalat password ki koshishain. Customer support se rabta karein."
    },
    'emergency_confirm': {
        'en': "🚨 EMERGENCY ACTIVATED: All cards are now locked. Fraud team has been alerted. Please call customer support to verify your identity.",
        'ur': "🚨 ایمرجنسی فعال: تمام کارڈز اب بند ہیں۔ فراڈ ٹیم کو الرٹ کر دیا گیا ہے۔ براۓ کرم کسٹمر سپورٹ کو کال کریں۔",
        'ru': "🚨 EMERGENCY ACTIVATED: Saare cards ab locked hain. Fraud team ko alert kar diya gaya hai. Customer support ko call karein."
    },
    'emergency_confirm_card': {
        'en': "🚨 EMERGENCY ACTIVATED: Your card ending {card} is now locked. Fraud team has been alerted. Please call customer support to verify your identity.",
        'ur': "🚨 ایمرجنسی فعال: آپ کا کارڈ (آخری ہندسے \u2066{card}\u2069) اب بند ہے۔ فراڈ ٹیم کو الرٹ کر دیا گیا ہے۔ براۓ کرم کسٹمر سپورٹ کو کال کریں۔",
        'ru': "🚨 EMERGENCY ACTIVATED: Aap ka card (aakhri digits {card}) ab locked hai. Fraud team ko alert kar diya gaya hai. Customer support ko call karein."
    },
    'emergency_no_cards_registered': {
        'en': "You don't have any cards linked to your account yet, so there's nothing to lock. If you believe your account has been compromised, please contact customer support directly.",
        'ur': "آپ کے اکاؤنٹ کے ساتھ ابھی کوئی کارڈ منسلک نہیں ہے، اس لیے بند کرنے کے لیے کچھ نہیں ہے۔ اگر آپ کو لگتا ہے کہ آپ کا اکاؤنٹ خطرے میں ہے تو براۓ کرم براہ راست کسٹمر سپورٹ سے رابطہ کریں۔",
        'ru': "Aap ke account se abhi koi card linked nahi hai, is liye lock karne ke liye kuch nahi hai. Agar aapko lagta hai ke aapka account compromise hua hai, to please seedha customer support se rabta karein."
    },
    'emergency_which_card': {
        'en': "You have {count} cards on file. Which one would you like to lock?\n{card_list}",
        'ur': "آپ کے پاس \u2066{count}\u2069 کارڈز موجود ہیں۔ آپ کون سا بند کرنا چاہتے ہیں؟\n{card_list}",
        'ru': "Aap ke paas {count} cards hain. Aap konsa lock karna chahte hain?\n{card_list}"
    },
    'emergency_card_invalid_choice': {
        'en': "❌ Sorry, I didn't catch that. Please reply with the number of the card (e.g. \"1\") or its last 4 digits.",
        'ur': "❌ معذرت، یہ سمجھ نہیں آیا۔ براۓ کرم کارڈ کا نمبر (مثلاً \"1\") یا اس کے آخری 4 ہندسے لکھیں۔",
        'ru': "❌ Maaf karein, yeh samajh nahi aaya. Card ka number (jaise \"1\") ya aakhri 4 digits batayein."
    },
    'password_incorrect': {
        'en': "❌ Incorrect password. Transaction cancelled.",
        'ur': "❌ غلط پاس ورڈ۔ ٹرانزیکشن منسوخ کر دی گئی۔",
        'ru': "❌ Ghalat password. Transaction cancel kar di gayi."
    },
    'insufficient_funds': {
        'en': "❌ Insufficient funds. Your balance is RS {balance:,}.",
        'ur': "❌ ناکافی فنڈز۔ آپ کا بیلنس \u2066RS {balance:,}\u2069 ہے۔",
        'ru': "❌ Nakafi funds. Aap ka balance RS {balance:,} hai."
    },
    'insufficient_points': {
        'en': "❌ Insufficient points. You have {points} points but need {required} points.",
        'ur': "❌ ناکافی پوائنٹس۔ آپ کے پاس \u2066{points}\u2069 پوائنٹس ہیں لیکن \u2066{required}\u2069 پوائنٹس کی ضرورت ہے۔",
        'ru': "❌ Nakafi points. Aap ke paas {points} points hain lekin {required} points ki zaroorat hai."
    },
    'human_handoff': {
        'en': "Sure thing — connecting you to a human banker now...",
        'ur': "ٹھیک ہے، آپ کو بینکر سے جوڑا جا رہا ہے...",
        'ru': "Bilkul — aapko ek human banker se jorha ja raha hai..."
    },

    # ---- Cancellation / edit / confirmation / help templates ----
    'global_cancel_transfer': {
        'en': "Your transfer has been cancelled.",
        'ur': "آپ کی ٹرانسفر منسوخ کر دی گئی ہے۔",
        'ru': "Aap ka transfer cancel kar diya gaya hai."
    },
    'global_cancel_bill': {
        'en': "Your bill payment has been cancelled.",
        'ur': "آپ کی بل ادائیگی منسوخ کر دی گئی ہے۔",
        'ru': "Aap ka bill payment cancel kar diya gaya hai."
    },
    'global_cancel_redeem': {
        'en': "Your points redemption has been cancelled.",
        'ur': "آپ کی پوائنٹس ریڈیمپشن منسوخ کر دی گئی ہے۔",
        'ru': "Aap ka points redemption cancel kar diya gaya hai."
    },
    'global_cancel_generic': {
        'en': "Okay, cancelled. How else can I help?",
        'ur': "ٹھیک ہے، منسوخ کر دیا گیا۔ میں مزید کیسے مدد کر سکتا ہوں؟",
        'ru': "Theek hai, cancel kar diya. Aur kis tarah madad karoon?"
    },
    'edit_reprompt_amount': {
        'en': "No problem - what should the new amount be?",
        'ur': "کوئی بات نہیں - نئی رقم کتنی ہونی چاہیے؟",
        'ru': "Koi baat nahi - naya amount kitna hona chahiye?"
    },
    'edit_reprompt_account_number': {
        'en': "Sure - what's the correct account number?",
        'ur': "ٹھیک ہے - درست اکاؤنٹ نمبر کیا ہے؟",
        'ru': "Theek hai - sahi account number kya hai?"
    },
    'edit_reprompt_transfer_method': {
        'en': "Okay - which transfer method should it be: IBAN, Account Number, or Raast ID?",
        'ur': "ٹھیک ہے - کون سا ٹرانسفر میتھڈ ہونا چاہیے: IBAN، Account Number، یا Raast ID؟",
        'ru': "Theek hai - konsa transfer method hona chahiye: IBAN, Account Number, ya Raast ID?"
    },
    'edit_reprompt_transfer_identifier': {
        'en': "Sure - what's the correct phone number?",
        'ur': "ٹھیک ہے - درست فون نمبر کیا ہے؟",
        'ru': "Theek hai - sahi phone number kya hai?"
    },
    'edit_reprompt_purpose': {
        'en': "Got it - what should the purpose be instead?",
        'ur': "ٹھیک ہے - مقصد کیا ہونا چاہیے؟",
        'ru': "Theek hai - purpose kya hona chahiye?"
    },
    'edit_reprompt_description': {
        'en': "Sure - what should the description be instead?",
        'ur': "ٹھیک ہے - تفصیل کیا ہونی چاہیے؟",
        'ru': "Theek hai - description kya honi chahiye?"
    },
    'edit_reprompt_bill_type': {
        'en': "Okay - which bill type should it be?",
        'ur': "ٹھیک ہے - بل کی قسم کیا ہونی چاہیے؟",
        'ru': "Theek hai - bill type kya hona chahiye?"
    },
    'edit_reprompt_bill_category': {
        'en': "Okay - which bill category should it be: Electricity, Gas, or Internet?",
        'ur': "ٹھیک ہے - بل کیٹیگری کیا ہونی چاہیے: Electricity، Gas، یا Internet؟",
        'ru': "Theek hai - bill category kya honi chahiye: Electricity, Gas, ya Internet?"
    },
    'edit_reprompt_service_provider': {
        'en': "Sure - which provider should it be instead?",
        'ur': "ٹھیک ہے - کون سا پرووائیڈر ہونا چاہیے؟",
        'ru': "Theek hai - konsa provider hona chahiye?"
    },
    'edit_reprompt_bill_reference': {
        'en': "Sure - what's the correct bill reference number? (digits only)",
        'ur': "ٹھیک ہے - درست بل ریفرنس نمبر کیا ہے؟ (صرف نمبر)",
        'ru': "Theek hai - sahi bill reference number kya hai? (sirf numbers)"
    },
    'edit_nothing_to_edit': {
        'en': "There's nothing to edit yet - what would you like to do?",
        'ur': "ابھی ترمیم کرنے کے لیے کچھ نہیں ہے - آپ کیا کرنا چاہتے ہیں؟",
        'ru': "Abhi edit karne ke liye kuch nahi hai - aap kya karna chahte hain?"
    },
    'confirmation_unclear': {
        'en': "Sorry, I didn't catch that. Please reply yes or no.",
        'ur': "معذرت، سمجھ نہیں سکا۔ براۓ کرم yes یا no میں جواب دیں۔",
        'ru': "Maafi, samajh nahi saka. Please yes ya no mein jawab dein."
    },
    'help_generic': {
        'en': "I can help you check your balance, send money, pay bills, check rewards, or redeem points. Just tell me what you'd like to do.",
        'ur': "میں آپ کا بیلنس چیک کرنے، پیسے بھیجنے، بل ادا کرنے، انعامات چیک کرنے یا پوائنٹس ریڈیم کرنے میں مدد کر سکتا ہوں۔",
        'ru': "Main aap ka balance check karne, paisa bhejne, bill pay karne, rewards check karne ya points redeem karne mein madad kar sakta hoon."
    },
    'help_transfer_amount': {
        'en': "Just type how much money you'd like to send, e.g. \"5000\" or \"RS 5,000\".",
        'ur': "صرف وہ رقم لکھیں جو آپ بھیجنا چاہتے ہیں، مثلاً \"5000\"۔",
        'ru': "Bas wo amount type karein jo aap bhejna chahte hain, maslan \"5000\"."
    },
    'help_transfer_account': {
        'en': "Type the recipient's account number - a mix of letters and numbers, 6-20 characters (e.g. ABC12345678).",
        'ur': "وصول کنندہ کا اکاؤنٹ نمبر لکھیں - حروف اور ہندسوں کا مرکب، 6 سے 20 حروف (مثلاً ABC12345678)۔",
        'ru': "Recipient ka account number type karein - letters aur numbers ka mix, 6-20 characters (maslan ABC12345678)."
    },
    'help_transfer_method': {
        'en': "Tell me how you'd like to send the money: IBAN, Account Number, or Raast ID.",
        'ur': "بتائیں آپ کس طریقے سے پیسے بھیجنا چاہتے ہیں: IBAN، Account Number، یا Raast ID۔",
        'ru': "Batayein aap kis tareeqe se paisa bhejna chahte hain: IBAN, Account Number, ya Raast ID."
    },
    'help_transfer_identifier': {
        'en': "Type the recipient's registered phone number, e.g. 03001234567. We'll automatically find their name and account.",
        'ur': "وصول کنندہ کا رجسٹرڈ فون نمبر لکھیں، مثلاً 03001234567۔ ہم خودکار طور پر ان کا نام اور اکاؤنٹ تلاش کر لیں گے۔",
        'ru': "Recipient ka registered phone number type karein, e.g. 03001234567. Hum automatically unka naam aur account dhoond lenge."
    },
    'help_transfer_purpose': {
        'en': "Tell me the purpose of this transfer: Rent, Salary, Business, Personal, or Other.",
        'ur': "بتائیں اس ٹرانسفر کا مقصد کیا ہے: Rent، Salary، Business، Personal، یا Other۔",
        'ru': "Batayein is transfer ka purpose kya hai: Rent, Salary, Business, Personal, ya Other."
    },
    'help_transfer_description': {
        'en': "Optionally tell me a category for this transfer (e.g. Grocery, Rent, Utility Bills), or say \"skip\".",
        'ur': "چاہیں تو اس ٹرانسفر کے لیے ایک کیٹیگری بتائیں، یا \"skip\" لکھیں۔",
        'ru': "Chahein to is transfer ke liye ek category batayein, ya \"skip\" likhein."
    },
    'help_transfer_confirmation': {
        'en': "Reply \"yes\" to confirm this transfer, or \"no\" to change something.",
        'ur': "اس ٹرانسفر کی تصدیق کے لیے \"yes\" لکھیں، یا کچھ تبدیل کرنے کے لیے \"no\"۔",
        'ru': "Is transfer ko confirm karne ke liye \"yes\" likhein, ya kuch change karne ke liye \"no\"."
    },
    'help_bill_type': {
        'en': "Tell me which bill you'd like to pay: electricity, gas, internet, or water.",
        'ur': "بتائیں کون سا بل ادا کرنا ہے: بجلی، گیس، انٹرنیٹ، یا پانی۔",
        'ru': "Batayein konsa bill pay karna hai: electricity, gas, internet, ya water."
    },
    'help_bill_category': {
        'en': "Tell me which bill you'd like to pay: Electricity, Gas, or Internet.",
        'ur': "بتائیں کون سا بل ادا کرنا ہے: Electricity، Gas، یا Internet۔",
        'ru': "Batayein konsa bill pay karna hai: Electricity, Gas, ya Internet."
    },
    'help_bill_provider': {
        'en': "Tell me your service provider, e.g. K-Electric, LESCO, SSGC, PTCL, etc.",
        'ur': "اپنا سروس پرووائیڈر بتائیں، مثلاً K-Electric، LESCO، SSGC، PTCL، وغیرہ۔",
        'ru': "Apna service provider batayein, maslan K-Electric, LESCO, SSGC, PTCL, waghera."
    },
    'help_bill_reference': {
        'en': "Type your bill's reference number (digits only), found on your bill statement.",
        'ur': "اپنے بل کا ریفرنس نمبر (صرف نمبر) لکھیں، جو آپ کے بل سٹیٹمنٹ پر موجود ہے۔",
        'ru': "Apne bill ka reference number (sirf numbers) type karein, jo bill statement par hota hai."
    },
    'help_bill_amount': {
        'en': "Type how much your bill amount is.",
        'ur': "بتائیں آپ کا بل کتنا ہے۔",
        'ru': "Batayein aap ka bill kitna hai."
    },
    'help_bill_confirmation': {
        'en': "Reply \"yes\" to confirm this bill payment, or \"no\" to change something.",
        'ur': "اس بل ادائیگی کی تصدیق کے لیے \"yes\" لکھیں، یا کچھ تبدیل کرنے کے لیے \"no\"۔",
        'ru': "Is bill payment ko confirm karne ke liye \"yes\" likhein, ya kuch change karne ke liye \"no\"."
    },
    'help_redeem_choice': {
        'en': "Reply with 1 for the PKR 500 Cash Voucher, or 2 for the PKR 250 Bill Discount.",
        'ur': "PKR 500 کیش واؤچر کے لیے 1 لکھیں، یا PKR 250 بل ڈسکاؤنٹ کے لیے 2۔",
        'ru': "PKR 500 Cash Voucher ke liye 1 likhein, ya PKR 250 Bill Discount ke liye 2."
    },
    'help_password': {
        'en': "Please type your account password to continue.",
        'ur': "براۓ کرم جاری رکھنے کے لیے اپنا پاس ورڈ لکھیں۔",
        'ru': "Please jari rakhne ke liye apna password likhein."
    },
}


def detect_language(text: str) -> str:
    """Detect language: 'ur' (Urdu script), 'ru' (Roman Urdu), 'en' (English).

    Uses \b word-boundary matching instead of naive substring
    containment so short common English substrings ('se', 'ko', 'ka', 'ada')
    embedded inside longer English words no longer trigger false 'ru'
    classifications.  E.g. "Karachi", "send", "service", "use" are now safe.
    """
    # Urdu script wins immediately if any Arabic-block code-point is present.
    if any('\u0600' <= c <= '\u06FF' for c in text):
        return 'ur'

    # Word list; each entry is checked as a complete token.
    roman_words = [
        'aap', 'main', 'hai', 'hain', 'hoon', 'kya', 'bhejo', 'bhejdo', 'bhejna',
        'kitna', 'kitne', 'kitnay', 'ketna', 'ketne',
        'mere', 'mera', 'mery', 'meri', 'mujhe', 'mujhay', 'humein', 'hamein',
        'karo', 'kro', 'karna', 'krna', 'kardo', 'karein', 'kijiye',
        'batao', 'btao', 'batain', 'batana', 'dikhaiye',
        'dijiye', 'chahta', 'chahte', 'chahiye',
        'bijli', 'bjili', 'bijlee', 'bijly',
        'pani', 'paani', 'paisa', 'paise', 'paisay',
        'rupay', 'rupaye', 'rupaya', 'rupye',
        'rakam', 'raqam',
        'khata', 'khaata', 'khatta',
        'yaad', 'yad', 'baki', 'baqi',
        'maloom', 'raseed', 'tarikh',
        'chori', 'gum', 'khoya',
        'lain', 'dain', 'len', 'den',
        'shukriya', 'salam', 'assalam',
        'nahi', 'nai', 'haan', 'ji',
        'theek', 'galat', 'sahi',
        'pichle', 'pichli', 'agla',
        'bhej',  # short, but only matched as full token now
    ]
    text_lower = text.lower()
    if any(re.search(r'\b' + re.escape(w) + r'\b', text_lower) for w in roman_words):
        return 'ru'

    return 'en'


# ─────────────────────────────────────────────────────────────────────────────
# Language stickiness helpers
# ─────────────────────────────────────────────────────────────────────────────

# Minimum token count of a new-language signal required to override the locked
# session_language.  Must be a real sentence in a completely different language.
_LANG_OVERRIDE_MIN_TOKENS = 5

# Short/ambiguous patterns that must NEVER trigger a language override.
# These cover: bare numbers, currency amounts, one-word yes/no/confirmations,
# account numbers, reference numbers, and any other pure slot-fill that
# contains no reliable language signal.
_AMBIGUOUS_REPLY_PATTERNS = [
    # Pure numbers or numbers with currency suffixes
    r'^\s*\d[\d\s,\.]*(\s*(rs\.?|pkr|rupees?|lakh|crore|روپے|روپیہ))?\s*$',
    # One-word yes/no/confirmations in any language
    r'^\s*(ok|okay|yes|no|y|n|haan|nahi|ji|theek|sahi|galat|confirm|proceed|ha|nope)\s*$',
    # Single digit (redemption choice)
    r'^\s*[1-9]\s*$',
    # Pure alphanumeric (account numbers, reference numbers)
    r'^\s*[A-Z0-9]{4,20}\s*$',
    # Indic-digit only input (Eastern Arabic numerals)
    r'^[\s۰-۹,\.]+$',
    # Short mixed currency: "5000 rs", "pkr 3000", "rs 2500"
    r'^\s*(rs\.?\s*)?\d[\d,\.]*(\s*(rs\.?|pkr|rupees?))?\s*$',
]

# Words/tokens that are ONLY meaningful as slot-fillers and carry zero
# language signal — used to detect "entire message is slot-fill content"
_SLOT_FILL_ONLY_TOKENS = frozenset([
    # affirmatives/negatives
    'yes', 'no', 'ok', 'okay', 'haan', 'nahi', 'ji', 'theek', 'sahi',
    'galat', 'confirm', 'proceed', 'ha', 'nope', 'yep', 'yeah',
    # currency
    'rs', 'pkr', 'rupees', 'rupee', 'rupay', 'rupaye',
    # account/reference label words
    'account', 'number', 'ref', 'no', 'acc',
    # Urdu-script affirmatives/negatives (carry no independent language
    # signal beyond what Step 1 of resolve_language() already handles,
    # but included here for consistency with the Latin-script tokens above).
    'ہاں', 'جی', 'ٹھیک', 'بالکل', 'درست', 'صحیح',
    'نہیں', 'نہ', 'غلط', 'منسوخ', 'کینسل',
])


def _is_ambiguous_reply(text: str) -> bool:
    """Return True if *text* is a slot-fill that carries no reliable language
    signal: raw numbers, currency amounts, yes/no, account numbers, etc."""
    t = text.strip()
    if not t:
        return True
    # Pattern-level check
    if any(re.search(p, t, re.IGNORECASE) for p in _AMBIGUOUS_REPLY_PATTERNS):
        return True
    # Token-level check: if every meaningful token is either a digit or a
    # known slot-fill-only word, the message has no language signal
    tokens = [tok.lower() for tok in re.split(r'\s+', t) if tok]
    if not tokens:
        return True
    meaningful = [tok for tok in tokens
                  if tok not in _SLOT_FILL_ONLY_TOKENS and not re.match(r'^[\d,\.]+$', tok)]
    # If there are no meaningful tokens at all → ambiguous
    if not meaningful:
        return True
    # If the ONLY meaningful tokens are a single Urdu/RU word already known
    # to be a confirmation (haan, ji, theek, etc.) → ambiguous
    if len(meaningful) == 1 and meaningful[0] in {
        'haan', 'nahi', 'ji', 'theek', 'sahi', 'galat',
        'ہاں', 'جی', 'ٹھیک', 'بالکل', 'درست', 'صحیح', 'نہیں', 'نہ', 'غلط', 'منسوخ',
    }:
        return True
    return False


def resolve_language(user_message: str, ctx: Dict) -> str:
    """Return the effective language for this turn.

    Rules (in order of priority):
    1. Urdu script code-point → always 'ur', immediately, no threshold needed.
    2. A flow is currently active AND we already have a lock → the lock is
       authoritative, full stop. This check runs BEFORE the "no lock"
       fallback specifically so that a transient/missing `session_language`
       during an active flow can't nuke the language mid-conversation - a
       slot answer is data, not a fresh language signal. It doesn't matter
       whether the amount, account number, recipient name, or confirmation
       is typed in English, Roman Urdu, or Urdu script, the conversation
       keeps speaking whatever language it started in until the flow
       finishes or is cancelled.
    3. No lock at all yet → detect fresh.
    4. Active flow (lock already handled by step 2, this covers the
       already-locked case falling through) → lock is final.
    5. No active flow (back at the top level) AND the message is an
       ambiguous slot-fill (number, yes/no, account ref) → retain lock.
    6. No active flow AND the new message is in a DIFFERENT language
       with >= _LANG_OVERRIDE_MIN_TOKENS meaningful tokens → genuine
       language switch, override the lock.
    """
    # Step 1: Urdu script wins unconditionally — no threshold, no lock needed.
    if any('\u0600' <= c <= '\u06FF' for c in user_message):
        return 'ur'

    locked = ctx.get('session_language')

    # Step 2: An active flow is authoritative the moment we have a lock,
    # checked BEFORE the "no lock" fallback so a transient missing key
    # during an active flow can't nuke the language mid-conversation.
    if ctx.get('current_flow') and locked:
        return locked

    # Step 3: No lock → just detect.
    if locked is None:
        return detect_language(user_message)

    # Step 4: Active flow → lock is final, regardless of what language the
    # slot answer happens to be written in.
    if ctx.get('current_flow'):
        return locked

    # Step 5: Idle / top-level, but the message itself carries no reliable
    # language signal (bare number, yes/no, account ref) → retain lock.
    if _is_ambiguous_reply(user_message):
        return locked

    # Step 6: Idle / top-level, genuine new instruction → may switch.
    detected = detect_language(user_message)
    if detected != locked:
        tokens = [t for t in re.split(r'\s+', user_message.strip()) if t]
        if len(tokens) < _LANG_OVERRIDE_MIN_TOKENS:
            return locked
        return detected

    return locked


# ─────────────────────────────────────────────────────────────────────────────
# Phonetic bucket normalizer
# ─────────────────────────────────────────────────────────────────────────────

# Groups of orthographic/phonetic variants that map to the same canonical form.
# Used by the fuzzy slang matcher and the normalization pipeline.
PHONETIC_BUCKETS: Dict[str, List[str]] = {
    'electricity': ['bijli', 'bijly', 'bijlee', 'bijaly', 'bjili', 'bijlee'],
    'water':       ['pani', 'paani', 'paane'],
    'gas':         ['sui gas', 'suigas', 'sui gais', 'gas'],
    'send':        ['bhejo', 'bhej', 'bhej do', 'bhejdo', 'bhejna', 'bhejein', 'bhejiye'],
    'money':       ['paisa', 'paise', 'paisay', 'paisaa'],
    'account':     ['khata', 'khaata', 'khatta'],
    'amount':      ['rakam', 'raqam'],
    'rupees':      ['rupay', 'rupaye', 'rupaya', 'rupye', 'rupaiye'],
    'reminder':    ['yaad', 'yad'],
    'remaining':   ['baki', 'baqi'],
    'receipt':     ['raseed'],
    'history':     ['tarikh', 'tarikhi'],
}

# Inverted index: variant → canonical
_PHONETIC_CANONICAL: Dict[str, str] = {
    variant: canonical
    for canonical, variants in PHONETIC_BUCKETS.items()
    for variant in variants
}


def normalize_to_phonetic_bucket(word: str) -> str:
    """Return the canonical bucket form for *word*, or *word* unchanged."""
    return _PHONETIC_CANONICAL.get(word.lower(), word)


# ─────────────────────────────────────────────────────────────────────────────
# Edit-distance <= 1 fuzzy slang helper
# ─────────────────────────────────────────────────────────────────────────────

def _edit_distance_one(a: str, b: str) -> bool:
    """Return True if Levenshtein distance between *a* and *b* is ≤ 1."""
    if a == b:
        return True
    la, lb = len(a), len(b)
    if abs(la - lb) > 1:
        return False
    # substitution / transposition on equal-length strings
    if la == lb:
        diffs = sum(ca != cb for ca, cb in zip(a, b))
        return diffs <= 1
    # one insertion / deletion
    short, long_ = (a, b) if la < lb else (b, a)
    i = j = 0
    found_diff = False
    while i < len(short) and j < len(long_):
        if short[i] != long_[j]:
            if found_diff:
                return False
            found_diff = True
            j += 1
        else:
            i += 1
            j += 1
    return True


def fuzzy_slang_lookup(token: str) -> Optional[str]:
    """Return the canonical slang mapping for *token*, using an exact match
    first, then edit-distance ≤ 1 fallback against SLANG_MAPPING keys."""
    t = token.lower()
    if t in SLANG_MAPPING:
        return SLANG_MAPPING[t]
    # Edit-distance ≤ 1 among single-word keys only (skip multi-word phrases
    # to avoid false positives on short tokens).
    for key in SLANG_MAPPING:
        if ' ' not in key and _edit_distance_one(t, key):
            return SLANG_MAPPING[key]
    return None


# ─────────────────────────────────────────────────────────────────────────────
# Per-token language tagger
# ─────────────────────────────────────────────────────────────────────────────

# English-only word list used by the per-token tagger (very light, no NLTK).
_EN_COMMON = frozenset([
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'shall', 'can', 'to', 'of', 'in', 'on',
    'at', 'for', 'with', 'by', 'from', 'into', 'through', 'about',
    'send', 'transfer', 'pay', 'check', 'show', 'balance', 'account',
    'money', 'bill', 'electricity', 'water', 'gas', 'internet',
    'history', 'statement', 'reward', 'points', 'redeem', 'block',
    'card', 'lock', 'emergency', 'human', 'agent', 'person', 'help',
    'yes', 'no', 'ok', 'okay', 'cancel', 'stop', 'proceed', 'confirm',
])

_RU_VOCAB = frozenset(SLANG_MAPPING.keys()) | frozenset([
    'aap', 'main', 'hai', 'hoon', 'kya', 'mere', 'mera', 'mery', 'meri',
    'karo', 'karna', 'batao', 'dijiye', 'chahta', 'chahte', 'chahiye',
    'nahi', 'haan', 'ji', 'theek', 'galat', 'sahi',
])


def tag_tokens(text: str) -> List[Tuple[str, str]]:
    """Tag each whitespace-separated token with 'en', 'ur-script', or 'ru'.

    Returns a list of (token, tag) tuples.  Tokens that can't be classified
    confidently default to 'en'.  The tagger is intentionally lightweight —
    it never blocks entity extraction on ambiguous tokens.
    """
    tokens = text.split()
    result: List[Tuple[str, str]] = []
    for tok in tokens:
        if any('\u0600' <= c <= '\u06FF' for c in tok):
            result.append((tok, 'ur-script'))
        elif tok.lower() in _RU_VOCAB:
            result.append((tok, 'ru'))
        elif tok.lower() in _EN_COMMON or tok.isdigit():
            result.append((tok, 'en'))
        else:
            result.append((tok, 'en'))   # safe default
    return result


def dominant_language_from_tags(tags: List[Tuple[str, str]]) -> str:
    """Return the most frequent language tag from a tagged-token list,
    falling back to 'en' on a tie."""
    if not tags:
        return 'en'
    counts: Dict[str, int] = {}
    for _, lang in tags:
        counts[lang] = counts.get(lang, 0) + 1
    return max(counts, key=lambda k: (counts[k], k == 'ru'))


# ─────────────────────────────────────────────────────────────────────────────
# Normalization pipeline
# ─────────────────────────────────────────────────────────────────────────────

_EASTERN_ARABIC_DIGITS = str.maketrans('۰۱۲۳۴۵۶۷۸۹', '0123456789')

# Unicode diacritic categories to strip on the *matching* copy only.
_DIACRITIC_CATEGORIES = frozenset(['Mn', 'Mc', 'Me'])


def _strip_diacritics(text: str) -> str:
    """Strip combining diacritical marks (e.g. Urdu harakat) from *text*."""
    return ''.join(c for c in unicodedata.normalize('NFD', text)
                   if unicodedata.category(c) not in _DIACRITIC_CATEGORIES)


def normalize_for_matching(text: str) -> str:
    """Full normalization pipeline for INTENT DETECTION / CLASSIFICATION.

    Pipeline:
    1. NFKC normalisation.
    2. Diacritic stripping (matching copy only).
    3. Whitespace & punctuation normalisation.
    4. Eastern Arabic-Indic digit → ASCII digit.
    5. Case folding.
    6. Slang / phonetic mapping.

    CRITICAL: This function MUST NOT be used as the input to entity extractors
    (names, account numbers, amounts).  Those extractors receive the minimally
    processed text produced by normalize_for_entity_extraction() below.
    """
    # Step 1: NFKC
    text = unicodedata.normalize('NFKC', text)
    # Step 2: diacritics (matching copy)
    text = _strip_diacritics(text)
    # Step 3: whitespace + punctuation
    text = re.sub(r'[^\w\s\u0600-\u06FF]', ' ', text)   # keep word chars + Urdu block
    text = re.sub(r'\s+', ' ', text).strip()
    # Step 4: Eastern Arabic-Indic digits
    text = text.translate(_EASTERN_ARABIC_DIGITS)
    # Step 5: case fold
    text = text.lower()
    # Step 6: slang / phonetic substitution
    #   Sort by key length descending so multi-word phrases win over their
    #   constituent single words.
    for slang_key in sorted(SLANG_MAPPING, key=len, reverse=True):
        text = re.sub(r'\b' + re.escape(slang_key) + r'\b', SLANG_MAPPING[slang_key], text)
    return text


def normalize_for_entity_extraction(text: str) -> str:
    """Minimal normalisation safe for entity extraction.

    ONLY applies:
    • NFKC normalisation.
    • Eastern Arabic-Indic → ASCII digit conversion.
    • Collapsing of redundant whitespace.

    Critically, NO slang substitution is applied, so a recipient named "Ada"
    or an account label containing a common word is never corrupted.
    """
    text = unicodedata.normalize('NFKC', text)
    text = text.translate(_EASTERN_ARABIC_DIGITS)
    text = re.sub(r'\s+', ' ', text).strip()
    return text


def normalize_slang(text: str) -> str:
    """Convert slang to standard form.

    Backward-compatible wrapper around the new normalize_for_matching()
    pipeline.  All internal callers that do intent/pattern matching already
    used this function, so they automatically gain the full Day-3 pipeline.
    Entity extractors call normalize_for_entity_extraction() directly.
    """
    return normalize_for_matching(text)


def extract_amount(text: str) -> Optional[int]:
    """
    Extract amount from text. Handles Eastern Arabic-Indic digits (۰-۹),
    South-Asian lakh/crore comma groupings, and currency markers.

    Notes on the parsing rules below:
    - Eastern Arabic-Indic digits are converted to ASCII first so
      ۵۰۰۰ is correctly parsed as 5000.
    - The numeric token accepts South-Asian lakh/crore digit
      groupings (e.g. "5,00,000") in addition to standard thousands
      groupings (e.g. "500,000") - any comma grouping is accepted and
      simply stripped before parsing.
    - Currency-marked amounts (Rs./PKR/rupees) are always preferred
      over bare numbers. If no currency marker is present and multiple
      bare numbers exist (e.g. "I have 2 accounts, send 5000"), the
      largest value is used instead of blindly taking the leftmost match,
      since incidental context numbers are typically small relative to
      the actual transaction amount.
    - Decimals are preserved through float conversion rather than
      being stripped, so "100.50" never mutates into "10050".
    """
    # Normalise Indic digits before any pattern matching
    text = text.translate(_EASTERN_ARABIC_DIGITS)

    number_token = r'\d+(?:,\d+)*(?:\.\d+)?'

    currency_patterns = [
        r'rs\.?\s*(' + number_token + r')',
        r'pkr\s*(' + number_token + r')',
        r'(' + number_token + r')\s*rs\.?\b',
        r'(' + number_token + r')\s*rupees',
        r'(' + number_token + r')\s*(?:rupay|rupaye|rupaya|rupye)\b',
    ]

    for pattern in currency_patterns:
        match = re.search(pattern, text, re.IGNORECASE)
        if match:
            amount_str = match.group(1).replace(',', '')
            return int(float(amount_str))

    bare_matches = re.findall(r'\b(' + number_token + r')\b', text)
    if not bare_matches:
        return None

    values = [int(float(m.replace(',', ''))) for m in bare_matches]
    return max(values)


def extract_recipient_name(text: str) -> Optional[str]:
    """
    Extract recipient name from text.

    The excluded-words list covers common English + Roman-Urdu
    imperative slang verbs (including multi-word phrases like "bhej do")
    so they don't get captured as part of the name.
    The final candidate is sanity-checked - it must be non-empty,
    contain at least one alphabetic character, and not be composed
    entirely of digits/special characters. If it fails, return None so
    the caller can flag it as unparsed instead of silently corrupting it.
    A candidate that still contains a digit, a comma, or more than
    three words after the known-verb strip is treated as a full sentence
    (e.g. a fresh instruction like "usko 120 send kardo" or a cancel
    phrase like "ruko, usko 120 send kardo") rather than a bare name, and
    rejected - a real name doesn't normally contain numbers or commas.
    Urdu-script tokens and currency/amount words are excluded
    so روپے/بھیجو/رقم never become recipient names.
    Trailing particles like "hai", "ko", "ka" are stripped.
    """
    text = text.strip()
    if not text:
        return None

    # Reject immediately if the entire input is Urdu script — it's an
    # instruction, not a name.
    if any('\u0600' <= c <= '\u06FF' for c in text) and not any(c.isascii() and c.isalpha() for c in text):
        return None

    excluded_words = [
        'to', 'send', 'transfer', 'pay', 'bhejo', 'karo', 'ko', 'bhej',
        'bhejdo', 'bhej do', 'bhejna', 'kardo', 'usko', 'unko', 'ise',
        'isko', 'do', 'hai', 'hain', 'ka', 'ki', 'ke', 'mein', 'se',
        # currency words that should NEVER be names
        'rs', 'pkr', 'rupees', 'rupee', 'rupay', 'rupaye', 'rupaya',
        'money', 'paisa', 'paise', 'paisay', 'rakam', 'raqam',
        # verb variants
        'bhejiye', 'bhejein', 'transfer', 'karna', 'karein', 'kijiye',
    ]

    working_text = text
    multi_word = sorted([p for p in excluded_words if ' ' in p], key=len, reverse=True)
    for phrase in multi_word:
        working_text = re.sub(
            r'\b' + re.escape(phrase) + r'\b', '', working_text, flags=re.IGNORECASE
        )

    single_word_excluded = {p.lower() for p in excluded_words if ' ' not in p}

    # Also exclude any Urdu-script token (they are verbs/particles, not names)
    name_words = [
        w for w in working_text.split()
        if w.lower() not in single_word_excluded
        and not any('\u0600' <= c <= '\u06FF' for c in w)
    ]

    if not name_words:
        return None
    candidate = ' '.join(w.capitalize() for w in name_words)

    stripped_candidate = candidate.replace(' ', '')
    if not stripped_candidate:
        return None
    if not any(c.isalpha() for c in stripped_candidate):
        return None

    # Reject anything that still looks like a sentence rather than
    # a bare name once the known filler/verb words are gone.
    if any(c.isdigit() for c in candidate):
        return None
    if ',' in text:
        return None
    if len(candidate.split()) > 3:
        return None

    # Final safety: reject if the candidate is a known Urdu/RU function word
    _name_blocklist = {
        'hai', 'hain', 'ka', 'ki', 'ke', 'ko', 'se', 'mein', 'aur',
        'ya', 'bhi', 'hi', 'toh', 'par', 'pe', 'woh', 'yeh', 'main',
        'aap', 'hum', 'tum', 'rupay', 'rupaye', 'rupaya', 'paisa',
        'paise', 'rakam', 'raqam', 'bhejo', 'bhej', 'bhejna', 'karo',
        'electricity', 'gas', 'water', 'internet', 'bill',
    }
    if candidate.lower() in _name_blocklist:
        return None

    return candidate


def validate_account_number(text: str) -> Optional[str]:
    """
    Validate account number - must be mix of letters and numbers.

    Before stripping spaces, reject anything that reads like a full
    sentence/new instruction (e.g. "mobni ko 300 send kardo") rather than
    a bare account number - account numbers are typed as a single token,
    optionally preceded by a label like "account number". A message that
    still contains a known instruction verb after the label words are
    removed is treated as a fresh instruction and rejected, instead of
    being silently accepted as gibberish "account number" once spaces are
    stripped out.
    """
    raw = text.strip().lower()
    instruction_verbs = [
        'send', 'transfer', 'pay', 'bhejo', 'bhej', 'bhejdo', 'bhejna',
        'kardo', 'karo', 'karna',
    ]
    label_words = {'account', 'number', 'acc', 'no', 'ko', 'to', 'for'}
    remaining_words = [w for w in re.split(r'\s+', raw) if w and w not in label_words]
    if any(verb in remaining_words for verb in instruction_verbs) and len(remaining_words) > 1:
        return None

    text = text.strip().upper()

    # Word-boundary anchored regex instead of destructive substring
    # .replace() so identifiers like "NOOR123456" never get mangled into
    # "OOR123456" by an incidental "NO" match.
    text = re.sub(r'\b(ACCOUNT|NUMBER|ACC|NO)\b', '', text)
    text = text.replace(' ', '').strip()

    if not (6 <= len(text) <= 20):
        return None

    has_letter = any(c.isalpha() for c in text)
    has_digit = any(c.isdigit() for c in text)
    is_alphanumeric = text.isalnum()

    if has_letter and has_digit and is_alphanumeric:
        return text

    return None


def extract_bill_type(text: str) -> Optional[str]:
    """Extract bill type from text"""
    normalized = normalize_slang(text.lower())

    bill_map = {
        'electricity': 'Electricity',
        'k-electric': 'Electricity',
        'lesco': 'Electricity',
        'bijli': 'Electricity',
        'electric': 'Electricity',
        'gas': 'Gas',
        'ptcl': 'Internet',
        'internet': 'Internet',
        'water': 'Water',
        'pani': 'Water',
    }

    for key, value in bill_map.items():
        if key in normalized:
            return value
    return None


# ── Bill Category / Service Provider (new pay_bill slots) ─────────────────
# Mirrors the app's "Bill Category" -> "Service Provider" dependent
# dropdowns. Category is restricted to the three categories the form
# actually offers; provider names are unique across categories so they
# can be recognized from free text without needing the already-selected
# category as context.
BILL_CATEGORY_MAP = {
    'electricity': 'Electricity',
    'k-electric': 'Electricity',
    'k electric': 'Electricity',
    'lesco': 'Electricity',
    'mepco': 'Electricity',
    'hesco': 'Electricity',
    'bijli': 'Electricity',
    'bijlee': 'Electricity',
    'electric': 'Electricity',
    'gas': 'Gas',
    'sui gas': 'Gas',
    'suigas': 'Gas',
    'ssgc': 'Gas',
    'sngpl': 'Gas',
    'internet': 'Internet',
    'ptcl': 'Internet',
    'transworld': 'Internet',
    'stormfiber': 'Internet',
    'storm fiber': 'Internet',
    'nayatel': 'Internet',
}

SERVICE_PROVIDER_MAP = {
    'Electricity': {
        'k-electric': 'K-Electric', 'k electric': 'K-Electric', 'kelectric': 'K-Electric',
        'lesco': 'LESCO', 'mepco': 'MEPCO', 'hesco': 'HESCO',
    },
    'Gas': {
        'ssgc': 'SSGC', 'sngpl': 'SNGPL',
    },
    'Internet': {
        'ptcl': 'PTCL', 'transworld': 'Transworld',
        'stormfiber': 'Stormfiber', 'storm fiber': 'Stormfiber',
        'nayatel': 'Nayatel',
    },
}

# Flattened lookup: any recognizable provider alias -> canonical name.
# Provider names don't overlap across categories, so this can be matched
# context-free from raw text.
_FLAT_PROVIDER_MAP = {
    alias: canonical
    for providers in SERVICE_PROVIDER_MAP.values()
    for alias, canonical in providers.items()
}

# What providers to suggest once a bill category has been chosen - used to
# render a helpful hint in the "which provider" prompt.
PROVIDERS_BY_CATEGORY_DISPLAY = {
    'Electricity': 'K-Electric, LESCO, MEPCO, or HESCO',
    'Gas': 'SSGC or SNGPL',
    'Internet': 'PTCL, Transworld, Stormfiber, or Nayatel',
}


def extract_bill_category(text: str) -> Optional[str]:
    """Extract the bill category (Electricity / Gas / Internet) - the new
    pay_bill first slot, matching the app's "Bill Category" dropdown."""
    normalized = normalize_slang(text.lower())
    # Longer/more specific keys first so e.g. "sui gas" matches before a
    # shorter accidental substring would.
    for key in sorted(BILL_CATEGORY_MAP.keys(), key=len, reverse=True):
        if key in normalized:
            return BILL_CATEGORY_MAP[key]
    return None


def extract_service_provider(text: str) -> Optional[str]:
    """Extract the service provider (e.g. LESCO, SSGC, PTCL) - the new
    pay_bill second slot, matching the app's "Service Provider" dropdown.
    Context-free: provider names are unique across categories."""
    normalized = normalize_slang(text.lower())
    for key in sorted(_FLAT_PROVIDER_MAP.keys(), key=len, reverse=True):
        if key in normalized:
            return _FLAT_PROVIDER_MAP[key]
    return None


# ── Transfer Method / Identifier / Purpose / Description (new
#    transfer_money slots) ──────────────────────────────────────────────
TRANSFER_METHOD_MAP = {
    'iban': 'IBAN',
    'account number': 'Account Number',
    'account no': 'Account Number',
    'acc number': 'Account Number',
    'acc no': 'Account Number',
    'account': 'Account Number',
    'raast id': 'Raast ID',
    'raast': 'Raast ID',
    # Roman Urdu variants
    'khata number': 'Account Number',
    'khaata number': 'Account Number',
    'khata no': 'Account Number',
    'khaata no': 'Account Number',
    'khata': 'Account Number',       # be careful: 'khata' alone is common
                                       # enough in casual speech that this
                                       # is reasonable, but sanity-check it
                                       # doesn't collide with any other
                                       # slot's vocabulary in this flow
    'ibaan': 'IBAN',                  # common phonetic misspelling
    # Urdu script variants
    #
    # IMPORTANT: extract_transfer_method() compares these keys against
    # normalize_slang(text) — NOT the raw survey text — and dict keys here
    # are matched as literal substrings, not re-normalized themselves. So
    # each key below must already be in its POST-NORMALIZATION form.
    # normalize_for_matching()'s diacritic-stripping step (NFD + combining-
    # mark removal) rewrites precomposed hamza/madda letters — آ ("alef
    # madda") strips down to bare ا, and ئ/ؤ ("yeh/waw with hamza above")
    # strip down to bare ي/و — so e.g. "آئی بین" (IBAN, as a user would
    # actually type/see it) normalizes to "ايی بین" at runtime, and it's
    # THAT string which must be the map key, not the pretty display form.
    # Verified empirically via normalize_for_matching() rather than assumed.
    'ايی بین': 'IBAN',                 # normalized form of "آئی بین"
    'اکاونٹ نمبر': 'Account Number',    # covers both "اکاؤنٹ نمبر" and "اکاونٹ نمبر" once normalized
    'کھاتہ نمبر': 'Account Number',     # no hamza/madda chars — normalizes unchanged
    'اکاونٹ': 'Account Number',        # normalized form of "اکاؤنٹ"
    'راست ايی ڈی': 'Raast ID',         # normalized form of "راست آئی ڈی"
    'راست': 'Raast ID',
}


def extract_transfer_method(text: str) -> Optional[str]:
    """Extract the transfer method (IBAN / Account Number / Raast ID) -
    matches the app's "Transfer Method" dropdown."""
    normalized = normalize_slang(text.lower())
    for key in sorted(TRANSFER_METHOD_MAP.keys(), key=len, reverse=True):
        if re.search(r'\b' + re.escape(key) + r'\b', normalized):
            return TRANSFER_METHOD_MAP[key]
    return None


def extract_transfer_identifier(text: str) -> Optional[str]:
    """
    Extract the recipient's destination identifier for a transfer.

    A Slot extractor only ever sees raw text (no access to which
    transfer_method was previously chosen), so this recognizes any of the
    three formats the app supports and returns whichever matches:
      - IBAN: 'PK' + 2 digits + 4-letter bank code + 16 digits = 24 total
        (e.g. PK36SCBL0000001123456702).
      - Raast ID: an 11-digit Pakistani mobile number (03XXXXXXXXX),
        optionally with a +92/0092/92 country-code prefix.
      - Account Number: 8-16 digits, numbers only.

    run_flow_step() is the one that checks the result against the
    transfer_method the user actually picked (see the special-case block
    for 'transfer_identifier' below) - this function just recognizes shapes.
    """
    raw = text.strip()
    if not raw:
        return None

    cleaned = re.sub(r'[\s-]', '', raw).upper()

    # IBAN check.
    if re.fullmatch(r'PK\d{2}[A-Z]{4}\d{16}', cleaned):
        return cleaned

    # Raast ID / phone number check (local or intl format).
    phone = extract_phone_number_pk(cleaned)
    if phone:
        return phone

    # Plain account number: digits only, 8-16 chars.
    if re.fullmatch(r'\d{8,16}', cleaned):
        return cleaned

    return None


def extract_phone_number_pk(text: str) -> Optional[str]:
    """
    Extract and normalize a Pakistani mobile number from free text.

    Accepts local format (03XXXXXXXXX / 03XX-XXXXXXX) and international
    format (+923XXXXXXXXX / 00923XXXXXXXXX / 923XXXXXXXXX). Returns the
    number normalized to local 11-digit form '03XXXXXXXXX', or None if no
    valid Pakistani mobile number is found in the text.
    """
    raw = text.strip()
    if not raw:
        return None

    # Reject obvious full-sentence instructions rather than a bare number
    # (e.g. "send 300 to him" contains no phone number anyway, but guard
    # against accidentally matching a stray digit run inside a longer
    # instruction that mixes an amount and other digits).
    digits_only = re.sub(r'[^\d+]', '', raw)
    digits_only = digits_only.replace('+', '')

    phone_match = re.search(r'(?:0092|92|0)?(3\d{9})\b', digits_only)
    if phone_match:
        return '0' + phone_match.group(1)

    return None


# Set by app.py at startup via set_recipient_resolver(). Given a normalized
# phone number ('03XXXXXXXXX'), must return {'account_number': ..., 'name': ...}
# on success or None if no registered user matches that phone number.
_recipient_resolver: Optional[Callable[[str], Optional[Dict[str, str]]]] = None


def set_recipient_resolver(resolver_fn: Callable[[str], Optional[Dict[str, str]]]) -> None:
    """
    Registers the PostgreSQL-backed phone -> (account_number, name) lookup
    function used to auto-resolve transfer recipients. Must be called once
    at app startup (see app.py). Never asks the user for a name directly -
    resolution is always via this DB lookup.
    """
    global _recipient_resolver
    _recipient_resolver = resolver_fn


# Set by app.py at startup via set_account_resolver(). Given a raw account
# number string, must return {'account_number': ..., 'name': ...} on success
# or None if it doesn't match any FinBud-AI account (e.g. it's a real
# external bank account number, which is expected and NOT an error).
_account_resolver: Optional[Callable[[str], Optional[Dict[str, str]]]] = None


def set_account_resolver(resolver_fn: Callable[[str], Optional[Dict[str, str]]]) -> None:
    """
    Registers the PostgreSQL-backed account_number -> (account_number, name)
    lookup used when the user picks "Account Number" as the transfer method.
    Unlike set_recipient_resolver(), a miss here is NOT treated as an error -
    it just means the number belongs to an external bank, so the flow falls
    back to asking the user to type the recipient's name manually.
    """
    global _account_resolver
    _account_resolver = resolver_fn


PURPOSE_MAP = {
    'rent': 'Rent',
    'salary': 'Salary',
    'business': 'Business',
    'personal': 'Personal',
    'other': 'Other',
}


def extract_purpose(text: str) -> Optional[str]:
    """Extract transfer purpose - matches the app's "Purpose" dropdown
    (Rent / Salary / Business / Personal / Other)."""
    normalized = normalize_slang(text.lower())
    for key in sorted(PURPOSE_MAP.keys(), key=len, reverse=True):
        if re.search(r'\b' + re.escape(key) + r'\b', normalized):
            return PURPOSE_MAP[key]
    return None


DESCRIPTION_MAP = {
    'utility bills': 'Utility Bills',
    'utility bill': 'Utility Bills',
    'utilities': 'Utility Bills',
    'grocery': 'Grocery',
    'groceries': 'Grocery',
    'household staff': 'Household Staff',
    'staff': 'Household Staff',
    'society maintenance': 'Society Maintenance',
    'maintenance': 'Society Maintenance',
    'car & fuel': 'Car & Fuel',
    'car and fuel': 'Car & Fuel',
    'fuel': 'Car & Fuel',
    'medical': 'Medical',
    'education': 'Education',
    'entertainment': 'Entertainment',
    'rent': 'Rent',
    'transfer': 'Transfer',
    'other': 'Other',
}

# The app's "Description" field is optional and defaults to "Transfer" -
# used to auto-fill the slot rather than blocking the conversation on it.
DEFAULT_TRANSFER_DESCRIPTION = 'Transfer'

# 'purpose' is no longer asked as its own slot (it duplicated 'description'
# - see FLOW_SLOT_ORDER['transfer_money']), but RESPONSES['transfer_confirm']
# and downstream consumers (app.py, frontend confirmation summaries) still
# read entities.get('purpose'), so it's silently defaulted to this instead.
DEFAULT_TRANSFER_PURPOSE = 'Personal'


def extract_description(text: str) -> Optional[str]:
    """Extract the (optional) transfer description/category - matches the
    app's "Description" dropdown. Defaults are handled by the caller;
    this only recognizes an explicit category if one is mentioned."""
    normalized = normalize_slang(text.lower())
    for key in sorted(DESCRIPTION_MAP.keys(), key=len, reverse=True):
        if re.search(r'\b' + re.escape(key) + r'\b', normalized):
            return DESCRIPTION_MAP[key]
    return None


def extract_bill_reference(text: str) -> Optional[str]:
    """Extract bill reference number — digits only.

    Eastern Arabic-Indic digits are translated to ASCII first,
    before the cleanup regex runs, so native-digit reference numbers are
    never silently stripped.

    Strip common Urdu and English label/filler phrases before
    isolating the numeric token, so "mera reference number hay 13346789"
    yields "13346789" and not "MERAHAY13346789".

    Returns None (rather than a permissive fallback) when no run of 4-20
    digits can be found — reference numbers are numeric-only, matching the
    bank's real bill-statement format.
    """
    text = text.strip()
    # Normalise Indic digits before any further processing.
    text = text.translate(_EASTERN_ARABIC_DIGITS)

    # Strip common label/filler words (English AND Urdu/Roman Urdu).
    # Order matters: strip multi-word phrases before single words.
    label_phrases = [
        r'\bmera\s+reference\s+number\s+hai\b',
        r'\bmera\s+reference\s+number\s+hay\b',
        r'\bmera\s+reference\s+hai\b',
        r'\breference\s+number\s+hai\b',
        r'\breference\s+number\s+hay\b',
        r'\bref\s+no\b',
        r'\bref\s+number\b',
        r'\bmy\s+reference\s+(?:number\s+)?is\b',
        r'\bmy\s+ref\b',
    ]
    for phrase in label_phrases:
        text = re.sub(phrase, '', text, flags=re.IGNORECASE)

    # Single label words
    excluded = ['bill', 'reference', 'number', 'ref', 'no', 'account',
                'mera', 'hay', 'hai', 'hain', 'ka', 'ki', 'ke', 'yeh', 'is', 'my']
    for word in excluded:
        text = re.sub(r'\b' + re.escape(word) + r'\b', '', text, flags=re.IGNORECASE)

    text = re.sub(r'\s+', ' ', text).strip()

    # Isolate a contiguous run of digits, 4–20 chars long. No fallback to
    # non-numeric input — genuinely non-numeric text returns None so the
    # caller can re-prompt via the 'bill_reference_invalid' response.
    tokens = re.findall(r'\d{4,20}', text)
    if tokens:
        # Prefer the longest token (most likely to be the actual reference)
        return max(tokens, key=len)

    return None


def extract_card_selection(text: str, cards: List[Dict]) -> Optional[str]:
    """
    Match a user's reply against a list of the account's cards during
    EMERGENCY_AWAIT_CARD_SELECTION.

    `cards` is a list of dicts shaped like features.list_cards()'s output:
    [{'card_id': ..., 'card_number_masked': '**** **** **** 1234', ...}, ...]

    Supports two natural ways of picking a card:
      - A 1-based list position ("1", "2", "option 2", "دوسرا").
      - The card's last 4 digits, typed anywhere in the message (e.g.
        "1234" or "the one ending 1234").

    Returns the matching card's 'card_id', or None if nothing matched
    (including an out-of-range position, or digits that don't match any
    card's last 4).
    """
    if not cards:
        return None

    stripped = text.strip()

    # 1-based position match: a bare (or near-bare) small number.
    pos_match = re.search(r'(?<!\d)([1-9])(?!\d)', stripped)
    if pos_match:
        idx = int(pos_match.group(1)) - 1
        if 0 <= idx < len(cards):
            return cards[idx].get('card_id')

    # Last-4-digits match: look for any 4-digit run in the reply and
    # compare it against each card's masked number.
    digit_runs = re.findall(r'\d{4}', stripped)
    for run in digit_runs:
        for card in cards:
            masked = card.get('card_number_masked', '')
            if masked.endswith(run):
                return card.get('card_id')

    return None


    """
    Extract redemption choice from text.

    Standalone option numbers are matched with negative lookaround so
    they can't match inside a longer digit run (e.g. "1500 points" no
    longer wrongly maps to Option 1 just because it contains the digit
    '1'). Explicit reward values / ordinal words are checked first since
    they're unambiguous.
    """
    text_lower = text.lower()

    if re.search(r'\b500\b', text_lower):
        return 500
    if re.search(r'\b250\b', text_lower):
        return 250

    if re.search(r'\bsecond\b', text_lower):
        return 250
    if re.search(r'\bfirst\b', text_lower):
        return 500

    if re.search(r'(?<!\d)2(?!\d)', text_lower):
        return 250
    if re.search(r'(?<!\d)1(?!\d)', text_lower):
        return 500

    return None


def extract_recipient_name_for_transfer_followup(text: str) -> Optional[str]:
    """
    Same as extract_recipient_name, but additionally rejects a small
    leftover-keyword set (transfer verbs / currency words / generic role
    words) that extract_recipient_name's title-casing fallback could
    otherwise misread as a name when called on a full free-form message.
    Matches the behavior of the top-level transfer_money entry point.
    "colleague", "friend", "person", "someone" etc. are generic
    role descriptions, not names — reject them here.
    """
    recipient = extract_recipient_name(strip_amount_substring(text))
    leftover_keywords = {
        'send', 'transfer', 'pay', 'rs', 'pkr', 'rupees',
        'rupee', 'money', 'payment', 'paisa', 'paise',
        # generic role/relationship words — not actual names
        'colleague', 'friend', 'someone', 'person', 'him', 'her',
        'them', 'it', 'he', 'she', 'they', 'anyone', 'somebody',
        'relative', 'brother', 'sister', 'mother', 'father', 'uncle',
        'aunt', 'wife', 'husband', 'partner', 'boss', 'employee',
    }
    if recipient and recipient.lower() in leftover_keywords:
        return None
    return recipient


def strip_amount_substring(user_message: str) -> str:
    """Remove the first amount-like substring (with adjacent currency
    marker) from a message, so a leftover "Rs"/"PKR" token doesn't get
    stuck to a subsequently-extracted recipient name, e.g.
    "send RS 5000 to Ahmed" must not yield "Rs Ahmed"."""
    amount_strip_pattern = (
        r'(rs\.?\s*|pkr\s*)?'
        r'\d+(?:,\d+)*(?:\.\d+)?'
        r'(\s*rs\.?\b|\s*rupees\b)?'
    )
    return re.sub(amount_strip_pattern, '', user_message, count=1, flags=re.IGNORECASE)


TRANSFER_SLOTS = {
    # NOTE: there is deliberately no 'recipient' slot here. The recipient's
    # name is never requested from, or parsed out of, the user's free text.
    # It is populated automatically in run_flow_step() the moment
    # 'transfer_identifier' (the phone number) is filled and resolved
    # against PostgreSQL.
    'transfer_method': Slot(
        name='transfer_method',
        extractor=extract_transfer_method,
        on_missing_response_key='transfer_ask_method',
        on_invalid_response_key='transfer_method_invalid',
    ),
    'transfer_identifier': Slot(
        name='transfer_identifier',
        extractor=extract_transfer_identifier,
        on_missing_response_key='transfer_ask_identifier',
        on_invalid_response_key='transfer_invalid_identifier',
    ),
    'amount': Slot(
        name='amount',
        extractor=extract_amount,
        on_missing_response_key='transfer_ask_amount',
    ),
    # 'purpose' slot removed - it duplicated 'description' (both asked
    # "why are you sending this money"). ctx['purpose'] is now silently
    # defaulted to 'Personal' instead (see DEFAULT_TRANSFER_DESCRIPTION
    # pre-seeding below) so templates/consumers that still read it keep
    # working unchanged.
    'description': Slot(
        name='description',
        extractor=extract_description,
        on_missing_response_key='transfer_ask_description',
    ),
}

BILL_SLOTS = {
    'bill_category': Slot(
        name='bill_category',
        extractor=extract_bill_category,
        on_missing_response_key='bill_ask_category',
    ),
    'service_provider': Slot(
        name='service_provider',
        extractor=extract_service_provider,
        on_missing_response_key='bill_ask_provider',
    ),
    'bill_reference': Slot(
        name='bill_reference',
        extractor=extract_bill_reference,
        on_missing_response_key='bill_ask_reference',
        on_invalid_response_key='bill_reference_invalid',
    ),
    'amount': Slot(
        name='amount',
        extractor=extract_amount,
        on_missing_response_key='bill_ask_amount',
    ),
}

FLOW_SLOTS = {
    'transfer_money': TRANSFER_SLOTS,
    'pay_bill': BILL_SLOTS,
}

# Help-template key for each (flow, slot) pair - used by the contextual
# help interceptor.
HELP_KEY_FOR_SLOT = {
    ('transfer_money', 'transfer_method'): 'help_transfer_method',
    ('transfer_money', 'transfer_identifier'): 'help_transfer_identifier',
    ('transfer_money', 'amount'): 'help_transfer_amount',
    ('transfer_money', 'description'): 'help_transfer_description',
    ('pay_bill', 'bill_category'): 'help_bill_category',
    ('pay_bill', 'service_provider'): 'help_bill_provider',
    ('pay_bill', 'bill_reference'): 'help_bill_reference',
    ('pay_bill', 'amount'): 'help_bill_amount',
}

# Legacy clarification_type strings (matching the contract app.py /
# any consumer might already pattern-match on) for each slot's "missing"
# case. Falls back to f'{slot}_missing' for any slot not listed here.
CLARIFICATION_TYPE_FOR_SLOT = {
    'amount': 'amount_missing',
    'transfer_method': 'transfer_method_missing',
    'transfer_identifier': 'transfer_identifier_missing',
    'description': 'description_missing',
    'bill_category': 'bill_category_missing',
    'service_provider': 'service_provider_missing',
    'bill_reference': 'bill_reference_missing',
}


def _matches_any(text: str, patterns: List[str]) -> bool:
    return any(re.search(p, text, re.IGNORECASE) for p in patterns)


def check_global_controls(user_message: str, ctx: Dict) -> Optional[Dict]:
    """
    Runs on every turn, BEFORE any active-flow slot extraction or fresh
    intent detection. Returns a fully-formed result dict if it intercepts
    the turn, or None if the turn should fall through to normal flow
    handling.

    Order of precedence (most disruptive first):
      1. Emergency pre-emption - card-block always wins, even
         mid-flow, and the interrupted flow's state is preserved so it can
         be resumed later.
      2. Global cancel - wipes the active transaction context and
         confirms exactly what was cancelled.
      3. Contextual help - answered relative to ctx['current_flow'].

    NOTE: while the user is in the middle of providing a raw password
    (awaiting_password / awaiting_emergency_password), we deliberately do
    NOT run cancel/help interception against the raw text, since a
    password could legitimately contain a word like "stop" or "help".
    Emergency pre-emption still applies even during password entry, since
    a genuine card-block request takes priority over any in-progress
    transaction.
    """
    awaiting_raw_password = bool(
        ctx.get('awaiting_password') or ctx.get('awaiting_emergency_password')
    )

    # Use the session-locked language for all interceptor responses.
    language = resolve_language(user_message, ctx)
    normalized = normalize_slang(user_message)

    # --- 1. Emergency pre-emption ----------------------------------------
    if _matches_any(normalized, INTENT_PATTERNS['emergency']):
        suspended_state = None
        suspended_flow = ctx.get('current_flow')
        if suspended_flow or awaiting_raw_password:
            # Snapshot everything needed to resume later. We keep this as
            # a plain dict copy (not popped/mutated) so the caller can
            # stash it under ctx['suspended_state'] untouched.
            suspended_state = {k: v for k, v in ctx.items() if k != 'suspended_state'}

        # This interceptor has no DB access (it's pure text-in/dict-out,
        # same constraint noted on _recipient_resolver's design), and card
        # count/selection needs the CALLER's own account_number - which,
        # unlike a phone/account number typed into a transfer, is never
        # part of the free text here. So app.py (which has account_number
        # via session) is responsible for turning this preliminary result
        # into the final one: 0 cards -> emergency_no_cards_registered
        # (never reaches the password step), 1 card -> unchanged, 2+ cards
        # -> EMERGENCY_AWAIT_CARD_SELECTION instead. See app.py's handling
        # of intent == 'emergency'.
        result = {
            'intent': 'emergency',
            'language': language,
            'entities': {},
            'needs_clarification': True,
            'clarification_type': 'password_required',
            'requires_human': False,
            'handoff_reason': None,
            'normalized_text': normalized,
            'ai_response': RESPONSES['emergency_password_request'][language],
            'awaiting_emergency_password': True,
            'emergency_attempts': 3,
            'flow_state': FlowState.EMERGENCY_AWAIT_PASSWORD.name,
            'emergency_lock_all': bool(_matches_any(normalized, EMERGENCY_ALL_CARDS_PATTERNS)),
        }
        if suspended_flow:
            result['suspended_flow'] = suspended_flow
        if suspended_state:
            result['suspended_state'] = suspended_state
        return result

    # Everything below this point should not run against raw password text.
    if awaiting_raw_password:
        return None

    # --- 2. Global cancel -------------------------------------------------
    if _matches_any(normalized, CANCEL_PATTERNS):
        current_flow = ctx.get('current_flow')
        cancel_key_map = {
            'transfer_money': 'global_cancel_transfer',
            'pay_bill': 'global_cancel_bill',
            'redeem_points': 'global_cancel_redeem',
        }
        response_key = cancel_key_map.get(current_flow, 'global_cancel_generic')

        return {
            'intent': 'cancelled',
            'language': language,
            'entities': {},
            'needs_clarification': False,
            'clarification_type': None,
            'requires_human': False,
            'handoff_reason': None,
            'normalized_text': normalized,
            'ai_response': RESPONSES[response_key][language],
            'cancelled_flow': current_flow,
            'flow_state': FlowState.IDLE.name,
        }

    # --- 3. Contextual help -------------------------------------------------
    if _matches_any(normalized, HELP_PATTERNS):
        current_flow = ctx.get('current_flow')
        help_key = 'help_generic'

        if current_flow == 'transfer_money':
            if ctx.get('flow_state') == FlowState.TRANSFER_AWAIT_CONFIRMATION.name:
                help_key = 'help_transfer_confirmation'
            else:
                for slot_name in FLOW_SLOT_ORDER['transfer_money']:
                    if not ctx.get(slot_name):
                        help_key = HELP_KEY_FOR_SLOT[('transfer_money', slot_name)]
                        break
        elif current_flow == 'pay_bill':
            if ctx.get('flow_state') == FlowState.BILL_AWAIT_CONFIRMATION.name:
                help_key = 'help_bill_confirmation'
            else:
                for slot_name in FLOW_SLOT_ORDER['pay_bill']:
                    if not ctx.get(slot_name):
                        help_key = HELP_KEY_FOR_SLOT[('pay_bill', slot_name)]
                        break
        elif current_flow == 'redeem_points':
            help_key = 'help_redeem_choice'

        return {
            'intent': 'help_requested',
            'language': language,
            'entities': {},
            'needs_clarification': bool(current_flow),
            'clarification_type': None,
            'requires_human': False,
            'handoff_reason': None,
            'normalized_text': normalized,
            'ai_response': RESPONSES[help_key][language],
            # Preserve the in-progress flow exactly as-is so help doesn't
            # derail an active conversation.
            **_passthrough_flow_fields(ctx),
        }

    return None


def _passthrough_flow_fields(ctx: Dict) -> Dict:
    """Re-emit the flow-identifying fields of ctx unchanged, for
    interceptors (like contextual help) that must answer without
    disturbing in-progress state."""
    passthrough = {}
    if ctx.get('current_flow'):
        passthrough['current_flow'] = ctx['current_flow']
    if ctx.get('flow_state'):
        passthrough['flow_state'] = ctx['flow_state']
    for key in ('amount', 'recipient', 'account_number', 'transfer_method', 'transfer_identifier',
                'purpose', 'description', 'bill_category', 'service_provider',
                'bill_reference', 'redemption_choice', 'provider_hint'):
        if key in ctx:
            passthrough[key] = ctx[key]
    return passthrough


def try_handle_edit_previous(user_message: str, ctx: Dict) -> Optional[Dict]:
    """
    Detects an "edit previous slot" request (e.g. "actually make it 6000
    instead", "go back") while a flow is active, pops the single most
    recently-filled slot, and re-prompts for just that slot - leaving every
    other already-collected slot untouched.

    Returns None if no edit-previous request is detected, or if there is
    nothing in the current flow that could meaningfully be edited yet
    (e.g. the very first slot of a fresh flow).
    """
    current_flow = ctx.get('current_flow')
    if current_flow not in FLOW_SLOT_ORDER:
        return None

    normalized = normalize_slang(user_message)
    if not _matches_any(normalized, EDIT_PREVIOUS_PATTERNS):
        return None

    language = resolve_language(user_message, ctx)
    slot_order = FLOW_SLOT_ORDER[current_flow]

    # Find the most recently filled slot: walk the slot order and take the
    # last one that's currently set in ctx. This is correct regardless of
    # whether we're mid-collection or already sitting in confirmation,
    # since at confirmation time every slot in slot_order is filled.
    filled_slots = [s for s in slot_order if ctx.get(s)]
    # 'description' is pre-seeded with a default ("Transfer") the moment a
    # transfer_money flow starts, since it's an optional field. Because
    # filled_slots is derived from slot ORDER (not fill recency), that
    # default would otherwise look like "the most recently filled slot"
    # any time it's the last slot ctx happens to have a value for - even
    # while earlier required slots are still empty. Only let 'description'
    # be a candidate once every other slot has actually been filled (i.e.
    # we're genuinely at/near the end of the flow).
    if current_flow == 'transfer_money' and 'description' in filled_slots:
        other_slots = [s for s in slot_order if s != 'description']
        if not all(ctx.get(s) for s in other_slots):
            filled_slots = [s for s in filled_slots if s != 'description']
    if not filled_slots:
        return {
            'intent': current_flow,
            'language': language,
            'entities': {},
            'needs_clarification': True,
            'clarification_type': None,
            'requires_human': False,
            'handoff_reason': None,
            'normalized_text': normalized,
            'ai_response': RESPONSES['edit_nothing_to_edit'][language],
            **_passthrough_flow_fields(ctx),
        }

    target_slot = filled_slots[-1]

    # Try to see if a new value was supplied in the SAME message (e.g.
    # "actually make it 6000 instead" both triggers the edit AND supplies
    # the replacement value in one turn).
    slot_def = FLOW_SLOTS[current_flow][target_slot]
    # Strip the edit-trigger words out before re-extracting, so e.g. the
    # word "instead" doesn't pollute a name/account extraction. Also strip
    # common connective filler ("make it", "it's", "it is") that tends to
    # surround the replacement value in natural correction phrasing -
    # these aren't extraction triggers themselves, just noise around the
    # actual new value.
    stripped_text = normalized
    all_strip_patterns = list(EDIT_PREVIOUS_PATTERNS) + [
        r"\bmake\s*it\b", r"\bit'?s\b", r"\bit\s*is\b", r"\bsorry\b",
    ]
    # Run to a fixed point: some patterns are substrings of others (e.g.
    # "i meant" inside "sorry i meant"), so a single pass can leave a
    # stray leftover word if the shorter pattern consumes part of what a
    # longer pattern further down the list was meant to match as a whole.
    for _ in range(3):
        changed = False
        for pattern in all_strip_patterns:
            new_stripped = re.sub(pattern, ' ', stripped_text, flags=re.IGNORECASE)
            if new_stripped != stripped_text:
                changed = True
            stripped_text = new_stripped
        if not changed:
            break
    stripped_text = stripped_text.strip()

    new_value = None
    if stripped_text:
        try:
            new_value = slot_def.extractor(stripped_text)
        except Exception:
            new_value = None
        if slot_def.validator and new_value is not None and not slot_def.validator(new_value):
            new_value = None

    new_ctx = {k: v for k, v in ctx.items()}
    new_ctx.pop(target_slot, None)
    if current_flow == 'pay_bill' and target_slot == 'bill_category':
        # service_provider and the provider_hint both depend on
        # bill_category - clear them too so editing the category doesn't
        # leave a stale, mismatched provider behind.
        new_ctx.pop('service_provider', None)
        new_ctx.pop('provider_hint', None)

    if current_flow == 'transfer_money' and target_slot == 'transfer_identifier':
        # recipient / account_number are derived FROM the phone number via
        # DB lookup, not typed directly - clear them too so editing the
        # phone number can never leave a stale name/account attached to a
        # newly-edited number. Route back through run_flow_step's normal
        # extraction path (not the inline skip_extraction shortcut below)
        # so the new number goes through the same PostgreSQL resolution
        # step as a first-time entry.
        new_ctx.pop('recipient', None)
        new_ctx.pop('account_number', None)
        return run_flow_step(user_message=stripped_text, ctx=new_ctx, language=language,
                              force_flow=current_flow, skip_extraction=False)

    if new_value is not None:
        # Value supplied inline - apply it immediately and move forward
        # exactly as if the user had been re-prompted and answered.
        new_ctx[target_slot] = new_value
        return run_flow_step(user_message="", ctx=new_ctx, language=language,
                              force_flow=current_flow, skip_extraction=True)

    # No inline replacement value - clear the slot and explicitly re-prompt
    # for just that one item.
    reprompt_key = f'edit_reprompt_{target_slot}'
    new_ctx['flow_state'] = FLOW_SLOT_STATE.get((current_flow, target_slot), FlowState.IDLE).name

    result = {
        'intent': current_flow,
        'language': language,
        'entities': {},
        'needs_clarification': True,
        'clarification_type': CLARIFICATION_TYPE_FOR_SLOT.get(target_slot, f'{target_slot}_missing'),
        'requires_human': False,
        'handoff_reason': None,
        'normalized_text': normalized,
        'ai_response': RESPONSES[reprompt_key][language],
        'current_flow': current_flow,
        'flow_state': new_ctx['flow_state'],
    }
    for key in slot_order:
        if key != target_slot and new_ctx.get(key):
            result[key] = new_ctx[key]
    if new_ctx.get('provider_hint'):
        result['provider_hint'] = new_ctx['provider_hint']
    # 'purpose' (see the carry-forward note in run_flow_step), and
    # 'recipient'/'account_number' (resolved via DB lookup rather than
    # being slots of their own - see TRANSFER_SLOTS) are none of them in
    # slot_order, so the loop above never re-emits them. Without this,
    # editing e.g. 'description' or 'amount' after the recipient has
    # already been resolved would silently drop the recipient/account
    # from context, causing a KeyError the next time the confirmation
    # prompt tries to render (it always expects ctx['recipient']).
    for extra_key in ('recipient', 'account_number', 'purpose'):
        if new_ctx.get(extra_key) is not None:
            result[extra_key] = new_ctx[extra_key]
    return result


def handle_confirmation_step(user_message: str, ctx: Dict, language: str) -> Dict:
    """
    Handles a turn where ctx['flow_state'] is *_AWAIT_CONFIRMATION. Strict
    yes/no/ambiguous handling - never guesses.
    """
    current_flow = ctx['current_flow']
    normalized = normalize_slang(user_message)

    if _matches_any(normalized, AFFIRMATIVE_PATTERNS):
        return _enter_password_state(current_flow, ctx, language)

    if _matches_any(normalized, NEGATIVE_PATTERNS):
        # Route to edit-previous-step logic automatically on "no".
        edit_result = try_handle_edit_previous("actually go back", ctx)
        if edit_result is not None:
            return edit_result
        # Fallback: shouldn't normally happen since all slots are filled
        # by the time we reach confirmation, but guard anyway.
        fallback_result = {
            'intent': current_flow,
            'language': language,
            'entities': {},
            'needs_clarification': True,
            'clarification_type': None,
            'requires_human': False,
            'handoff_reason': None,
            'normalized_text': normalized,
            'ai_response': RESPONSES['edit_nothing_to_edit'][language],
            **_passthrough_flow_fields(ctx),
        }
        fallback_result['flow_state'] = FLOW_CONFIRMATION_STATE[current_flow].name
        return fallback_result

    # Ambiguous - re-prompt for confirmation without guessing or falling
    # through to any other logic.
    confirm_key = 'transfer_confirm' if current_flow == 'transfer_money' else 'bill_confirm'
    ai_response = (
        RESPONSES['confirmation_unclear'][language] + "\n" +
        _render_confirmation_prompt(current_flow, ctx, language)
    )
    result = {
        'intent': current_flow,
        'language': language,
        'entities': {},
        'needs_clarification': True,
        'clarification_type': 'confirmation_required',
        'requires_human': False,
        'handoff_reason': None,
        'normalized_text': normalized,
        'ai_response': ai_response,
        **_passthrough_flow_fields(ctx),
    }
    # Explicitly (re)assert flow_state - _passthrough_flow_fields only
    # carries it over if it was already in ctx, but a caller that doesn't
    # round-trip flow_state (e.g. an unmodified app.py relying on the
    # all-slots-filled fallback) would otherwise get a result missing it
    # entirely. Confirmation state is unambiguous here: we only ever reach
    # this branch while sitting at *_AWAIT_CONFIRMATION.
    result['flow_state'] = FLOW_CONFIRMATION_STATE[current_flow].name
    return result


def handle_recipient_step(user_message: str, ctx: Dict, language: str) -> Dict:
    """
    Handles a turn where ctx['flow_state'] is TRANSFER_AWAIT_RECIPIENT. Two
    distinct modes share this state:
      - DB-resolved recipient (ctx['account_number'] already set from a
        Raast ID / Account Number match): expects yes/no confirming the
        auto-looked-up name is who the user meant to send to.
      - External/manual recipient (ctx['_awaiting_manual_recipient_name']
        is True, i.e. an IBAN or an unlisted account number): expects
        free-text with the recipient's name, since there's nothing FinBud
        can look up automatically for an external bank account.
    """
    current_flow = ctx['current_flow']
    normalized = normalize_slang(user_message)
    effective_language = ctx.get('session_language', language)

    if ctx.get('_awaiting_manual_recipient_name'):
        name = user_message.strip()
        if not name or len(name) < 2:
            result = {
                'intent': current_flow,
                'language': effective_language,
                'session_language': ctx.get('session_language', language),
                'entities': {},
                'needs_clarification': True,
                'clarification_type': 'transfer_recipient_name_missing',
                'requires_human': False,
                'handoff_reason': None,
                'normalized_text': normalized,
                'ai_response': RESPONSES['transfer_ask_recipient_name'][effective_language],
                'current_flow': current_flow,
                'flow_state': FlowState.TRANSFER_AWAIT_RECIPIENT.name,
                'transfer_identifier': ctx.get('transfer_identifier'),
                'transfer_method': ctx.get('transfer_method'),
                '_awaiting_manual_recipient_name': True,
            }
            if ctx.get('purpose') is not None:
                result['purpose'] = ctx['purpose']
            return result

        new_ctx = dict(ctx)
        new_ctx.pop('_awaiting_manual_recipient_name', None)
        new_ctx['recipient'] = name
        new_ctx['current_flow'] = current_flow
        result = run_flow_step(user_message="", ctx=new_ctx, language=language,
                                force_flow=current_flow, skip_extraction=True)
        result['session_language'] = ctx.get('session_language', language)
        return result

    # DB-resolved recipient - expects a yes/no confirmation.
    if _matches_any(normalized, AFFIRMATIVE_PATTERNS):
        new_ctx = dict(ctx)
        new_ctx['current_flow'] = current_flow
        result = run_flow_step(user_message="", ctx=new_ctx, language=language,
                                force_flow=current_flow, skip_extraction=True)
        result['session_language'] = ctx.get('session_language', language)
        return result

    if _matches_any(normalized, NEGATIVE_PATTERNS):
        # Wrong person - clear the resolved identity and go back to asking
        # for the identifier again, through the normal extraction path so
        # the newly-typed number gets the same method-aware validation.
        new_ctx = dict(ctx)
        new_ctx.pop('recipient', None)
        new_ctx.pop('account_number', None)
        new_ctx.pop('transfer_identifier', None)
        new_ctx['current_flow'] = current_flow
        result = run_flow_step(user_message="", ctx=new_ctx, language=language,
                                force_flow=current_flow, skip_extraction=False)
        result['session_language'] = ctx.get('session_language', language)
        return result

    # Ambiguous - re-ask without guessing.
    ai_response = (
        RESPONSES['confirmation_unclear'][effective_language] + "\n" +
        RESPONSES['transfer_recipient_found'][effective_language].format(
            name=ctx.get('recipient', '')
        )
    )
    result = {
        'intent': current_flow,
        'language': effective_language,
        'session_language': ctx.get('session_language', language),
        'entities': {},
        'needs_clarification': True,
        'clarification_type': 'transfer_recipient_confirmation',
        'requires_human': False,
        'handoff_reason': None,
        'normalized_text': normalized,
        'ai_response': ai_response,
        'current_flow': current_flow,
        'flow_state': FlowState.TRANSFER_AWAIT_RECIPIENT.name,
        'recipient': ctx.get('recipient'),
        'account_number': ctx.get('account_number'),
        'transfer_identifier': ctx.get('transfer_identifier'),
        'transfer_method': ctx.get('transfer_method'),
    }
    if ctx.get('purpose') is not None:
        result['purpose'] = ctx['purpose']
    return result


def _render_confirmation_prompt(current_flow: str, ctx: Dict, language: str) -> str:
    if current_flow == 'transfer_money':
        return RESPONSES['transfer_confirm'][language].format(
            amount=ctx['amount'], recipient=ctx['recipient'],
            transfer_method=ctx['transfer_method'],
            transfer_identifier=ctx['transfer_identifier'],
            purpose=ctx['purpose'], description=ctx['description'],
        )
    else:
        return RESPONSES['bill_confirm'][language].format(
            amount=ctx['amount'], bill_category=ctx['bill_category'],
            service_provider=ctx['service_provider'],
            bill_reference=ctx['bill_reference'],
        )


def _enter_password_state(current_flow: str, ctx: Dict, language: str) -> Dict:
    """Transition from confirmation into password collection - identical
    payload shape to what app.py already expects under awaiting_password."""
    if current_flow == 'transfer_money':
        amount, recipient = ctx['amount'], ctx['recipient']
        transfer_method, transfer_identifier = ctx['transfer_method'], ctx['transfer_identifier']
        purpose, description = ctx['purpose'], ctx['description']
        # account_number is the DB-resolved target account (from the
        # phone-number lookup) - always carried through to the password
        # step so app.py can post the transaction against the correct
        # account, not the raw phone number itself.
        pending_entities = {
            'amount': amount, 'recipient': recipient,
            'account_number': ctx.get('account_number'),
            'transfer_method': transfer_method, 'transfer_identifier': transfer_identifier,
            'purpose': purpose, 'description': description,
        }
        ai_response = RESPONSES['transfer_password_request'][language].format(
            amount=amount, recipient=recipient,
        )
    else:
        bill_category, service_provider = ctx['bill_category'], ctx['service_provider']
        bill_reference, amount = ctx['bill_reference'], ctx['amount']
        pending_entities = {
            'bill_category': bill_category, 'service_provider': service_provider,
            'bill_reference': bill_reference, 'amount': amount,
        }
        ai_response = RESPONSES['bill_payment_password_request'][language].format(
            bill_category=bill_category, service_provider=service_provider, amount=amount,
        )

    return {
        'intent': current_flow,
        'language': language,
        'entities': dict(pending_entities),
        'needs_clarification': True,
        'clarification_type': 'password_required',
        'requires_human': False,
        'handoff_reason': None,
        'normalized_text': "[REDACTED]",
        'ai_response': ai_response,
        'awaiting_password': True,
        'original_intent': current_flow,
        'pending_entities': pending_entities,
        'flow_state': (
            FlowState.TRANSFER_AWAIT_PASSWORD.name if current_flow == 'transfer_money'
            else FlowState.BILL_AWAIT_PASSWORD.name
        ),
    }


# Slots that are deliberately EXCLUDED from the generic pre-fill loop below
# because their extractors are open-ended/catch-all matchers designed to
# run only once the user has been specifically asked for that value (e.g.
# "what's your bill reference number?"). 'transfer_identifier' is excluded
# for a different reason: it's handled via method-inference instead (see
# _infer_transfer_method_from_identifier_shape), reusing run_flow_step's
# own resolution/validation logic rather than duplicating it.
#
# IMPORTANT: excluding a slot here does NOT fully shield it from the raw
# opening message. If every slot ordered before it does get pre-filled,
# it becomes the first still-empty slot, and run_flow_step's OWN
# extraction (on its very first, non-recursive call) will run that same
# extractor against the full raw message anyway. 'bill_reference' gets an
# extra confidence gate for exactly this reason - see the dedicated
# handling in _prefill_flow_slots below - rather than being silently
# excluded and left exposed to that same risk via a different code path.
PREFILL_EXCLUDED_SLOTS = {'transfer_identifier', 'bill_reference'}


def _infer_transfer_method_from_identifier_shape(user_message: str) -> Optional[str]:
    """
    Best-effort guess at which transfer_method the user meant, based on the
    SHAPE of a destination identifier found in their opening message -
    used only by the pre-fill pass, and only when the user didn't already
    name a method explicitly (see _prefill_flow_slots). This mirrors (but
    does not duplicate) the shape checks already performed inside
    run_flow_step's 'transfer_identifier' special-case block: the actual
    extraction, format validation, and DB resolution for the identifier
    itself is always left to that existing code, on the very next
    run_flow_step call - this function's only job is to pick a starting
    transfer_method so that call has one to check against.
    """
    extracted = extract_transfer_identifier(user_message)
    if not extracted:
        return None

    if re.fullmatch(r'PK\d{2}[A-Z]{4}\d{16}', extracted):
        return 'IBAN'
    if re.fullmatch(r'0(3\d{9})', extracted):
        # 11-digit 03XXXXXXXXX shape - most likely a Raast ID (the phone-
        # number-linked rail); try that first. If it turns out not to be
        # registered, run_flow_step's existing 'transfer_phone_not_found'
        # handling takes over on the very next call, exactly as it would
        # for a Raast ID typed on a later turn.
        return 'Raast ID'
    if re.fullmatch(r'\d{8,16}', extracted):
        return 'Account Number'
    return None


def _confident_bill_reference(user_message: str) -> Optional[str]:
    """
    A stricter wrapper around extract_bill_reference(), used ONLY by the
    pre-fill pass. extract_bill_reference() is intentionally permissive
    (by design, it "accepts anything reasonable" once it's been asked for
    directly - see its docstring) - fine when it's only ever run in
    response to "what's your bill reference number?", but too loose to
    run blindly against an entire opening message: e.g. on "pay my
    electricity bill of 3000 from lesco" it would happily return
    "ELECTRICITY" as if that were a reference number, because after label
    words are stripped, "ELECTRICITY" is still a bare 4+ character token.

    Real bill reference numbers always contain at least one digit, so
    requiring that here filters out that entire class of false positive
    without touching extract_bill_reference() itself (which must stay
    exactly as permissive as it already is for its normal, directly-asked
    use).
    """
    candidate = extract_bill_reference(user_message)
    if candidate and any(ch.isdigit() for ch in candidate):
        return candidate
    return None


def _prefill_flow_slots(user_message: str, current_flow: str, base_ctx: Dict) -> Dict:
    """
    Runs once, only on the turn a flow (transfer_money / pay_bill) first
    becomes active, BEFORE the first run_flow_step call. Without this,
    run_flow_step only ever extracts a value for the single first empty
    slot in FLOW_SLOT_ORDER - so an opening message that already answers
    several slots at once (e.g. "send 400RS to 03252118947") would have
    every slot after the first silently discarded, and the user would be
    re-asked for things they already said.

    Tries each slot's own extractor (the exact same ones run_flow_step
    would use later for that slot) against the raw user_message, in slot
    order, and fills `ctx` for every slot that extracts a valid value.
    This is purely additive: base_ctx is never overwritten, extraction
    failures are silently skipped (leaving the slot for the normal
    per-slot flow to ask about, same as today), and nothing here bypasses
    a validator a slot already has.

    'transfer_identifier' is handled specially (see
    _infer_transfer_method_from_identifier_shape) - only transfer_method
    may be pre-filled from it; the identifier value itself, its format
    validation, and its DB resolution are all left to run_flow_step's
    existing logic on the immediately-following call, so that logic never
    has to be duplicated here.

    'bill_reference' is also handled specially (see
    _confident_bill_reference) with an extra digit-presence check, rather
    than simply being skipped - see the PREFILL_EXCLUDED_SLOTS comment for
    why merely excluding it wouldn't actually avoid the false-positive risk.

    Never touches 'recipient' - recipient is never parsed from free text,
    only ever resolved server-side via 'transfer_identifier' (see the
    NOTE at the top of TRANSFER_SLOTS and FLOW_SLOT_ORDER).
    """
    ctx = dict(base_ctx)
    slot_order = FLOW_SLOT_ORDER[current_flow]
    slots = FLOW_SLOTS[current_flow]

    for slot_name in slot_order:
        if ctx.get(slot_name):
            # Already provided by the caller (e.g. the 'description'/
            # 'purpose' defaults pre-seeded by process_message) - don't
            # clobber it.
            continue

        if slot_name == 'bill_reference':
            extracted = _confident_bill_reference(user_message)
            if extracted is not None:
                ctx[slot_name] = extracted
            continue

        if slot_name in PREFILL_EXCLUDED_SLOTS:
            continue

        slot_def = slots[slot_name]
        try:
            extracted = slot_def.extractor(user_message)
        except Exception:
            extracted = None

        if extracted is None:
            continue
        if slot_def.validator and not slot_def.validator(extracted):
            continue

        ctx[slot_name] = extracted

        if current_flow == 'pay_bill' and slot_name == 'bill_category':
            # Mirrors the same side-effect run_flow_step performs when it
            # fills 'bill_category' itself (see the "advance" branch
            # below) - the dependent "Service Provider" prompt needs this
            # hint regardless of whether the category came from here or
            # from a later turn.
            ctx['provider_hint'] = PROVIDERS_BY_CATEGORY_DISPLAY.get(extracted, '')

    if current_flow == 'transfer_money' and not ctx.get('transfer_method'):
        inferred_method = _infer_transfer_method_from_identifier_shape(user_message)
        if inferred_method:
            ctx['transfer_method'] = inferred_method

    return ctx


def run_flow_step(user_message: str, ctx: Dict, language: str,
                   force_flow: Optional[str] = None,
                   skip_extraction: bool = False) -> Dict:
    # Whether this flow was already active *before* this call - i.e. the
    # user was already sitting at some slot's prompt and this message is
    # their reply to it, as opposed to a fresh "transfer money" that's
    # simultaneously triggering the flow AND being fed in as if it were an
    # answer to the very first slot. Only in the former case does failing
    # to extract a value mean the user actually gave an "invalid" answer -
    # on a fresh entry it just means the opening message didn't happen to
    # mention that slot's value yet, which is a normal "missing" case.
    flow_was_already_active = 'current_flow' in ctx
    current_flow = force_flow or ctx['current_flow']
    slot_order = FLOW_SLOT_ORDER[current_flow]
    slots = FLOW_SLOTS[current_flow]
    normalized = normalize_slang(user_message) if user_message else "[INLINE_EDIT]"
    # The effective session language is whatever is locked in ctx,
    # falling back to the language argument (which is the detected language
    # on this turn).  This ensures every response from run_flow_step is
    # already in the locked language without the caller needing to patch it.
    effective_language = ctx.get('session_language') or language

    # Find the first not-yet-filled slot.
    target_slot = None
    for slot_name in slot_order:
        if not ctx.get(slot_name):
            target_slot = slot_name
            break

    if target_slot is None:
        # All slots filled -> confirmation state.
        new_ctx = dict(ctx)
        new_ctx['current_flow'] = current_flow
        new_ctx['flow_state'] = FLOW_CONFIRMATION_STATE[current_flow].name
        ai_response = _render_confirmation_prompt(current_flow, new_ctx, effective_language)

        entities = {k: new_ctx[k] for k in slot_order}
        # 'purpose' is no longer a collected slot (see FLOW_SLOT_ORDER), but
        # it's silently pre-seeded in ctx (DEFAULT_TRANSFER_PURPOSE) and
        # still consumed by RESPONSES['transfer_confirm'] and downstream
        # consumers, so it has to be carried through like the other
        # not-in-slot_order fields below.
        for extra_key in ('recipient', 'account_number', 'purpose'):
            if new_ctx.get(extra_key) is not None:
                entities[extra_key] = new_ctx[extra_key]

        result = {
            'intent': current_flow,
            'language': effective_language,
            'session_language': ctx.get('session_language', language),
            'entities': entities,
            'needs_clarification': True,
            'clarification_type': 'confirmation_required',
            'requires_human': False,
            'handoff_reason': None,
            'normalized_text': normalized,
            'ai_response': ai_response,
            'current_flow': current_flow,
            'flow_state': new_ctx['flow_state'],
        }
        for key in slot_order:
            result[key] = new_ctx[key]
        for extra_key in ('recipient', 'account_number', 'purpose'):
            if new_ctx.get(extra_key) is not None:
                result[extra_key] = new_ctx[extra_key]
        return result

    slot_def = slots[target_slot]

    if skip_extraction:
        # Used by the inline-edit path: the value was already extracted
        # and placed into ctx by the caller, so this call's only job is to
        # figure out what comes next (which may itself be "all filled").
        # We re-enter with target_slot artificially treated as filled by
        # recursing once the caller has set ctx[target_slot].
        return run_flow_step(user_message="", ctx=ctx, language=language,
                              force_flow=current_flow, skip_extraction=False)

    extracted = None
    try:
        if target_slot == 'bill_reference' and not flow_was_already_active:
            # Fresh flow entry (this call's user_message is an opening
            # statement, not necessarily a targeted answer to "what's your
            # bill reference number?"). This only happens at all when the
            # pre-fill pass (see _prefill_flow_slots) has already filled
            # every slot ordered before 'bill_reference', which is new
            # behavior it introduces - in the old single-slot-only design,
            # a fresh entry's target_slot was always 'bill_category', never
            # 'bill_reference'. extract_bill_reference() is intentionally
            # permissive for its normal (directly-asked) use, so route
            # through the same stricter, digit-requiring check the
            # pre-fill pass itself uses, to avoid the same false-positive
            # class (e.g. "ELECTRICITY" from "pay my electricity bill of
            # 3000 from lesco" being mistaken for a reference number).
            extracted = _confident_bill_reference(user_message)
        else:
            extracted = slot_def.extractor(user_message)
    except Exception:
        extracted = None

    # Special-case transfer_money's 'transfer_identifier' slot: this is now
    # always a phone number, and the moment it's captured we resolve it
    # against PostgreSQL (users.phone -> account_number, name) instead of
    # ever asking the user for a recipient name. If the phone number isn't
    # registered, we intercept here with a clear error and keep waiting at
    # this same slot; the entity slot itself is left unset (never partially
    # filled with an unverified target). If it IS registered, recipient +
    # account_number are injected into ctx and we advance straight past
    # 'recipient' (which isn't even a collected slot) to whatever's next -
    # Amount, then Purpose/Description/Confirmation - with no intermediate
    # prompting.
    if (current_flow == 'transfer_money' and target_slot == 'transfer_identifier'
            and extracted is not None):

        chosen_method = ctx.get('transfer_method')
        is_phone = bool(re.fullmatch(r'0(3\d{9})', extracted))
        is_iban  = bool(re.fullmatch(r'PK\d{2}[A-Z]{4}\d{16}', extracted))
        is_acct  = bool(re.fullmatch(r'\d{8,16}', extracted)) and not is_phone

        # Reject shapes that don't match the method the user actually
        # picked (e.g. typing an IBAN after choosing "Raast ID") instead
        # of silently accepting whatever format happens to parse.
        method_matches = (
            (chosen_method == 'Raast ID' and is_phone) or
            (chosen_method == 'IBAN' and is_iban) or
            (chosen_method == 'Account Number' and (is_acct or is_phone))
        )

        if not method_matches:
            ai_response = RESPONSES['transfer_identifier_wrong_format'][effective_language]
            ai_response = _format_with_ctx(ai_response, ctx)
            result = {
                'intent': current_flow,
                'language': effective_language,
                'session_language': ctx.get('session_language', language),
                'entities': {},
                'needs_clarification': True,
                'clarification_type': 'transfer_identifier_wrong_format',
                'requires_human': False,
                'handoff_reason': None,
                'normalized_text': normalized,
                'ai_response': ai_response,
                'current_flow': current_flow,
                'flow_state': FLOW_SLOT_STATE[(current_flow, target_slot)].name,
            }
            for key in slot_order:
                if key != target_slot and ctx.get(key):
                    result[key] = ctx[key]
            # 'purpose' is pre-seeded at flow entry but isn't in slot_order
            # (see FLOW_SLOT_ORDER), so it has to be carried forward
            # explicitly here or it silently drops out of session context.
            if ctx.get('purpose') is not None:
                result['purpose'] = ctx['purpose']
            return result

        resolved = None
        if chosen_method == 'Raast ID':
            # Raast ID is Pakistan's real mobile-number-linked transfer
            # rail, so this path always tries to resolve the phone number
            # against PostgreSQL. Unlike Account Number below, a miss here
            # IS an error - there's no such thing as an "external" Raast ID.
            if _recipient_resolver is not None:
                try:
                    resolved = _recipient_resolver(extracted)
                except Exception:
                    resolved = None

            if not resolved:
                ai_response = RESPONSES['transfer_phone_not_found'][effective_language]
                result = {
                    'intent': current_flow,
                    'language': effective_language,
                    'session_language': ctx.get('session_language', language),
                    'entities': {},
                    'needs_clarification': True,
                    'clarification_type': 'transfer_identifier_not_found',
                    'requires_human': False,
                    'handoff_reason': None,
                    'normalized_text': normalized,
                    'ai_response': ai_response,
                    'current_flow': current_flow,
                    'flow_state': FLOW_SLOT_STATE[(current_flow, target_slot)].name,
                }
                for key in slot_order:
                    if key != target_slot and ctx.get(key):
                        result[key] = ctx[key]
                # See the 'purpose' carry-forward note above.
                if ctx.get('purpose') is not None:
                    result['purpose'] = ctx['purpose']
                return result

        elif chosen_method == 'Account Number':
            # Try resolving against FinBud's own accounts first - this is
            # the same underlying bank, so a match here is very likely.
            # Unlike Raast ID, a MISS is not an error: it just means the
            # number belongs to some other bank, so we fall through to the
            # manual-name path below instead of blocking the user.
            if _account_resolver is not None:
                try:
                    resolved = _account_resolver(extracted)
                except Exception:
                    resolved = None

        if resolved:
            # DB match (Raast ID, or an Account Number that happens to be a
            # FinBud-AI account) - don't silently assume this is the right
            # person; ask the user to confirm the looked-up name before
            # moving on to amount/purpose/etc.
            new_ctx = dict(ctx)
            new_ctx['transfer_identifier'] = extracted
            new_ctx['recipient'] = resolved['name']
            new_ctx['account_number'] = resolved['account_number']
            new_ctx['current_flow'] = current_flow
            ai_response = RESPONSES['transfer_recipient_found'][effective_language].format(
                name=resolved['name']
            )
            result = {
                'intent': current_flow,
                'language': effective_language,
                'session_language': ctx.get('session_language', language),
                'entities': {},
                'needs_clarification': True,
                'clarification_type': 'transfer_recipient_confirmation',
                'requires_human': False,
                'handoff_reason': None,
                'normalized_text': normalized,
                'ai_response': ai_response,
                'current_flow': current_flow,
                'flow_state': FlowState.TRANSFER_AWAIT_RECIPIENT.name,
                'recipient': resolved['name'],
                'account_number': resolved['account_number'],
                'transfer_identifier': extracted,
                'transfer_method': chosen_method,
            }
            # Carry forward any OTHER slot already filled (e.g. 'amount' or
            # 'description', if the pre-fill pass - see _prefill_flow_slots -
            # already pulled them out of the same opening message) so they
            # aren't lost while we pause here for recipient confirmation.
            for key in slot_order:
                if key not in ('transfer_identifier',) and ctx.get(key):
                    result[key] = ctx[key]
            if ctx.get('purpose') is not None:
                result['purpose'] = ctx['purpose']
            return result

        # No DB match for Account Number, or IBAN was never looked up
        # (IBANs aren't resolved against FinBud's own accounts, so
        # `resolved` stays None for that method by design).
        if chosen_method == 'Account Number':
            # An unresolved Account Number is treated as a probable typo,
            # not "this must be some other bank" - re-prompt for the same
            # slot instead of jumping to asking for a recipient name.
            # (IBAN and Raast ID "not found" behavior is untouched - see
            # the Raast ID branch above and the 'else' below for IBAN.)
            ai_response = RESPONSES['transfer_account_not_found'][effective_language]
            result = {
                'intent': current_flow,
                'language': effective_language,
                'session_language': ctx.get('session_language', language),
                'entities': {},
                'needs_clarification': True,
                'clarification_type': 'transfer_account_not_found',
                'requires_human': False,
                'handoff_reason': None,
                'normalized_text': normalized,
                'ai_response': ai_response,
                'current_flow': current_flow,
                'flow_state': FLOW_SLOT_STATE[(current_flow, target_slot)].name,
            }
            for key in slot_order:
                if key != target_slot and ctx.get(key):
                    result[key] = ctx[key]
            # See the 'purpose' carry-forward note above. transfer_identifier
            # is intentionally left unset so the user can retype it.
            if ctx.get('purpose') is not None:
                result['purpose'] = ctx['purpose']
            return result

        # No DB match: IBAN. This is an external-bank transfer - there's no
        # name to auto-verify, so ask the user to type it in directly
        # rather than inventing a placeholder like "Bank Account (...1234)".
        new_ctx = dict(ctx)
        new_ctx['transfer_identifier'] = extracted
        new_ctx['current_flow'] = current_flow
        new_ctx['_awaiting_manual_recipient_name'] = True
        ai_response = RESPONSES['transfer_ask_recipient_name'][effective_language]
        result = {
            'intent': current_flow,
            'language': effective_language,
            'session_language': ctx.get('session_language', language),
            'entities': {},
            'needs_clarification': True,
            'clarification_type': 'transfer_recipient_name_missing',
            'requires_human': False,
            'handoff_reason': None,
            'normalized_text': normalized,
            'ai_response': ai_response,
            'current_flow': current_flow,
            'flow_state': FlowState.TRANSFER_AWAIT_RECIPIENT.name,
            'transfer_identifier': extracted,
            'transfer_method': chosen_method,
            '_awaiting_manual_recipient_name': True,
        }
        # See the same carry-forward note in the 'resolved' branch above -
        # pre-filled 'amount'/'description' must survive this detour too.
        for key in slot_order:
            if key not in ('transfer_identifier',) and ctx.get(key):
                result[key] = ctx[key]
        if ctx.get('purpose') is not None:
            result['purpose'] = ctx['purpose']
        return result

    if slot_def.validator and extracted is not None and not slot_def.validator(extracted):
        extracted = None

    if extracted is None:
        is_ask = not (
            slot_def.on_invalid_response_key
            and user_message.strip()
            and flow_was_already_active
        )
        response_key = (
            slot_def.on_missing_response_key if is_ask else slot_def.on_invalid_response_key
        )

        # transfer_identifier's ask/invalid prompts depend on which
        # transfer_method was chosen (IBAN / Account Number / Raast ID) -
        # a phone-number-shaped prompt makes no sense once IBAN or Account
        # Number has been selected, so swap in the matching variant here.
        if current_flow == 'transfer_money' and target_slot == 'transfer_identifier':
            method = ctx.get('transfer_method')
            if method == 'IBAN':
                response_key = 'transfer_ask_identifier_iban' if is_ask else 'transfer_invalid_identifier_iban'
            elif method == 'Account Number':
                response_key = 'transfer_ask_identifier_account' if is_ask else 'transfer_invalid_identifier_account'

        ai_response_template = RESPONSES[response_key][effective_language]
        ai_response = _format_with_ctx(ai_response_template, ctx)

        result = {
            'intent': current_flow,
            'language': effective_language,
            'session_language': ctx.get('session_language', language),
            'entities': {},
            'needs_clarification': True,
            'clarification_type': (
                CLARIFICATION_TYPE_FOR_SLOT.get(target_slot, f'{target_slot}_missing')
                if is_ask
                else f'invalid_{target_slot}'
            ),
            'requires_human': False,
            'handoff_reason': None,
            'normalized_text': normalized,
            'ai_response': ai_response,
            'current_flow': current_flow,
            'flow_state': FLOW_SLOT_STATE[(current_flow, target_slot)].name,
        }
        for key in slot_order:
            if key != target_slot and ctx.get(key):
                result[key] = ctx[key]
        for extra_key in ('recipient', 'account_number', 'purpose'):
            if ctx.get(extra_key) is not None:
                result[extra_key] = ctx[extra_key]
        if ctx.get('provider_hint'):
            result['provider_hint'] = ctx['provider_hint']
        return result

    # Slot filled successfully - advance.
    new_ctx = dict(ctx)
    new_ctx[target_slot] = extracted
    new_ctx['current_flow'] = current_flow
    if current_flow == 'pay_bill' and target_slot == 'bill_category':
        # Precompute a provider hint (e.g. "K-Electric, LESCO, MEPCO, or
        # HESCO") so the next prompt can list the right options for the
        # category the user just picked - mirrors the app's dependent
        # "Service Provider" dropdown.
        new_ctx['provider_hint'] = PROVIDERS_BY_CATEGORY_DISPLAY.get(extracted, '')
    return run_flow_step(user_message="", ctx=new_ctx, language=language,
                          force_flow=current_flow, skip_extraction=False)


def _format_with_ctx(template: str, ctx: Dict) -> str:
    """Format a response template using whatever flow fields are already
    in ctx (amount/recipient/bill_category/etc.), tolerating missing keys."""
    try:
        return template.format(**ctx)
    except (KeyError, IndexError):
        return template



class BankAIConversation:
    """
    Pure NLP engine for banking conversations.
    Handles multilingual understanding (Urdu, English, Roman Urdu).
    Supports multi-step conversation flows via an explicit table-driven
    state machine (FlowState + FLOW_SLOT_ORDER), fronted by a global
    interceptor layer (emergency pre-emption, cancel, contextual help)
    that runs before any flow-specific logic on every turn.

    Backward compatibility: `self.intent_patterns`, `self.slang_mapping`,
    and `self.responses` are kept as instance attributes (mirroring the
    module-level constants) since app.py reads `chatbot.responses[...]`
    directly in several places.
    """

    def __init__(self):
        self.intent_patterns = INTENT_PATTERNS
        self.slang_mapping = SLANG_MAPPING
        self.responses = RESPONSES

    # -- thin instance-method wrappers over the module-level extractor functions,
    #    preserved so any external caller still doing `chatbot.extract_amount(...)`
    #    etc. keeps working exactly as before. --------------------------------
    def detect_language(self, text: str) -> str:
        return detect_language(text)

    def resolve_language(self, text: str, ctx: Dict = None) -> str:
        return resolve_language(text, ctx or {})

    def normalize_slang(self, text: str) -> str:
        return normalize_slang(text)

    def normalize_for_matching(self, text: str) -> str:
        return normalize_for_matching(text)

    def normalize_for_entity_extraction(self, text: str) -> str:
        return normalize_for_entity_extraction(text)

    def tag_tokens(self, text: str) -> List[Tuple[str, str]]:
        return tag_tokens(text)

    def extract_amount(self, text: str) -> Optional[int]:
        return extract_amount(text)

    def extract_recipient_name(self, text: str) -> Optional[str]:
        return extract_recipient_name(text)

    def validate_account_number(self, text: str) -> Optional[str]:
        return validate_account_number(text)

    def extract_bill_type(self, text: str) -> Optional[str]:
        return extract_bill_type(text)

    def extract_bill_reference(self, text: str) -> Optional[str]:
        return extract_bill_reference(text)

    def extract_bill_category(self, text: str) -> Optional[str]:
        return extract_bill_category(text)

    def extract_service_provider(self, text: str) -> Optional[str]:
        return extract_service_provider(text)

    def extract_transfer_method(self, text: str) -> Optional[str]:
        return extract_transfer_method(text)

    def extract_transfer_identifier(self, text: str) -> Optional[str]:
        return extract_transfer_identifier(text)

    def extract_purpose(self, text: str) -> Optional[str]:
        return extract_purpose(text)

    def extract_description(self, text: str) -> Optional[str]:
        return extract_description(text)

    def extract_redemption_choice(self, text: str) -> Optional[int]:
        return extract_redemption_choice(text)

    def detect_intent(self, text: str) -> str:
        """Detect user intent from user_message.

        Matches against THREE representations of the input:
        1. The original text (catches Urdu-script patterns directly).
        2. The normalize_for_matching() output (catches slang-substituted
           patterns like 'electricity', 'send', 'check').
        3. The raw lowercased text (catches Roman Urdu patterns before slang
           substitution, e.g. 'raseed', 'khata', 'chori' which slang
           substitution converts to 'receipt', 'account', 'theft' — the
           INTENT_PATTERNS contain the *original* RU words, not the
           substituted English ones).

        Using all three ensures no pattern is missed regardless of whether
        it was written expecting original or normalized input.
        """
        normalized = normalize_for_matching(text)
        raw_lower = text.lower().strip()
        # Also try with diacritics stripped but no slang substitution,
        # for Urdu-script patterns that survive NFKC/diacritic stripping
        urdu_stripped = _strip_diacritics(unicodedata.normalize('NFKC', text))

        candidates = [text, normalized, raw_lower, urdu_stripped]

        for intent, patterns in INTENT_PATTERNS.items():
            for pattern in patterns:
                for candidate in candidates:
                    try:
                        if re.search(pattern, candidate, re.IGNORECASE | re.UNICODE):
                            return intent
                    except re.error:
                        continue

        if re.match(r'^(hi|hello|hey|salam|assalam)', text.lower()):
            return 'greeting'

# ── Hybrid LLM fallback ───────────────────────────────────────────────
        try:
            self._llm = LLMFallback(
                model="openai/gpt-oss-120b"
                # Cheaper option: model="llama-3.1-8b-instant"
            )
            self._llm_enabled = True
        except Exception as _llm_exc:
            import logging
            logging.getLogger(__name__).warning("LLM fallback disabled: %s", _llm_exc)
            self._llm = None
            self._llm_enabled = False
        
        return 'unknown'
    # -- main entrypoint --------------------------------------------------

    def process_message(self, user_message: str, conversation_context: Dict = None) -> Dict:
        """
        Thin wrapper around `_process_message_impl()` that guarantees
        `session_language` is always present on the returned dict, even if
        some internal return path forgets to set it. This is defense at
        the root: rather than patching every branch that can omit the key
        (and having to remember to patch every future branch too), we
        resolve the language once here and backfill it onto whatever the
        real implementation returns.

        `resolve_language()` is read-only with respect to the ctx dict
        passed in - it only reads `session_language` / `current_flow` - so
        it's safe to call it here and have `_process_message_impl()` call
        it again internally on its own local copy of the context.
        """
        ctx = dict(conversation_context or {})
        language = resolve_language(user_message, ctx)
        result = self._process_message_impl(user_message, conversation_context)
        result['session_language'] = result.get('session_language') or language
        return result

    def _process_message_impl(self, user_message: str, conversation_context: Dict = None) -> Dict:
        """
        Main function: Analyze user message and manage conversation state.

        Returns the same flat dict shape the engine has always produced
        (intent / language / entities / needs_clarification /
        clarification_type / requires_human / handoff_reason /
        normalized_text / ai_response / current_flow / awaiting_password /
        awaiting_emergency_password / pending_entities / original_intent /
        plus flow slot values directly on the dict), with the following
        ADDITIVE new keys that app.py does not need to read for existing
        behavior to keep working, but which unlock additional features
        once app.py is updated to persist/forward them:

          - 'flow_state'        : str name of the current FlowState enum
                                   member. Should be round-tripped into
                                   session['conversation_context']['flow_state']
                                   the same way 'current_flow' already is.
          - 'suspended_state'   : present only on emergency pre-emption from
                                   inside an active flow. The FULL prior
                                   context dict, to be stashed verbatim
                                   under session['conversation_context']
                                   ['suspended_state'] so the interrupted
                                   flow can be restored later.
          - 'suspended_flow'    : the legacy current_flow string of the
                                   flow that got pre-empted, for convenience.
          - 'cancelled_flow'    : present only on a global-cancel turn;
                                   names which flow was wiped (or None).

        See the "APP.PY INTEGRATION NOTES" block at the end of this file
        for the minimal app.py diff needed to light these up end-to-end.
        """
        if conversation_context is None:
            conversation_context = {}
        ctx = dict(conversation_context)

        # Resolve effective language using session lock + high-threshold
        # override rule.  Falls back to detect_language for the first turn.
        language = resolve_language(user_message, ctx)
        # Persist the resolved language into ctx immediately so every
        # downstream path (interceptors, flow steps, helpers) has it.
        ctx['session_language'] = language

        # Raw password collection states bypass all interceptor/flow logic
        # except emergency pre-emption (handled inside check_global_controls,
        # which explicitly still fires here even when awaiting_password is
        # set - see its docstring). Card-selection is likewise a narrow,
        # single-purpose state, so it gets the same emergency pre-emption
        # carve-out (a genuine new lock request should still be able to
        # interrupt an in-progress card pick).
        emergency_intercept = None
        if (ctx.get('awaiting_password') or ctx.get('awaiting_emergency_password')
                or ctx.get('awaiting_emergency_card_selection')):
            normalized_check = normalize_slang(user_message)
            if _matches_any(normalized_check, INTENT_PATTERNS['emergency']):
                emergency_intercept = check_global_controls(user_message, ctx)

        if emergency_intercept is not None:
            return emergency_intercept

        if ctx.get('awaiting_emergency_card_selection'):
            # The list of the account's cards (card_id + masked number) was
            # stashed in ctx by app.py the turn the selection step was
            # entered - no DB access needed here, mirroring how other
            # slot-filling steps work off pre-fetched context rather than
            # querying mid-turn.
            cards = ctx.get('emergency_cards') or []
            selected_id = extract_card_selection(user_message, cards)
            if selected_id is not None:
                return {
                    'intent': 'emergency_card_selected',
                    'language': language,
                    'entities': {'card_id': selected_id},
                    'needs_clarification': True,
                    'clarification_type': 'password_required',
                    'requires_human': False,
                    'handoff_reason': None,
                    'normalized_text': normalize_slang(user_message),
                    'ai_response': RESPONSES['emergency_password_request'][language],
                    'awaiting_emergency_password': True,
                    'emergency_attempts': 3,
                    'flow_state': FlowState.EMERGENCY_AWAIT_PASSWORD.name,
                    # Also surfaced as a top-level key (not just inside
                    # 'entities') so app.py's Context management block —
                    # which reads nlp_result.get('emergency_card_id')
                    # generically for every path that sets
                    # awaiting_emergency_password — persists it the same
                    # way regardless of which turn set it.
                    'emergency_card_id': selected_id,
                }
            # Invalid selection - re-prompt, staying in the same state.
            # Re-render the same card list the user was already shown.
            card_list = "\n".join(
                f"{i+1}. {c.get('card_number_masked', '****')}"
                for i, c in enumerate(cards)
            )
            return {
                'intent': 'emergency_card_selection_invalid',
                'language': language,
                'entities': {},
                'needs_clarification': True,
                'clarification_type': 'card_selection_required',
                'requires_human': False,
                'handoff_reason': None,
                'normalized_text': normalize_slang(user_message),
                'ai_response': (
                    RESPONSES['emergency_card_invalid_choice'][language] + "\n\n" +
                    RESPONSES['emergency_which_card'][language].format(
                        count=len(cards), card_list=card_list
                    )
                ),
                'awaiting_emergency_card_selection': True,
                'emergency_cards': cards,
                'flow_state': FlowState.EMERGENCY_AWAIT_CARD_SELECTION.name,
            }

        if ctx.get('awaiting_emergency_password'):
            # Never echo the raw password text back out via
            # normalized_text. entities['password'] is deliberately kept
            # intact (not scrubbed) because app.py's emergency-unlock flow
            # depends on the real value for check_password_hash(); redacting
            # it here would silently break authentication.
            return {
                'intent': 'emergency_password_provided',
                'language': language,
                'entities': {'password': user_message.strip()},
                'needs_clarification': False,
                'clarification_type': None,
                'requires_human': False,
                'handoff_reason': None,
                'normalized_text': "[REDACTED]",
                'ai_response': None,
                'original_intent': 'emergency',
                'emergency_attempts': ctx.get('emergency_attempts', 3),
                'flow_state': FlowState.EMERGENCY_AWAIT_PASSWORD.name,
                # Carried forward from whichever earlier turn decided which
                # card(s) to act on (single-card auto-select, an explicit
                # "lock all my cards" phrase, or a multi-card selection
                # step) - see app.py's emergency_password_provided handler.
                'emergency_card_id': ctx.get('emergency_card_id'),
                'emergency_lock_all': ctx.get('emergency_lock_all', False),
            }

        if ctx.get('awaiting_password'):
            original_intent = ctx.get('original_intent')
            # Same rationale as above - normalized_text is
            # redacted, entities['password'] is preserved for downstream
            # check_password_hash() verification.
            return {
                'intent': 'password_provided',
                'language': language,
                'entities': {
                    'password': user_message.strip(),
                    **ctx.get('pending_entities', {})
                },
                'needs_clarification': False,
                'clarification_type': None,
                'requires_human': False,
                'handoff_reason': None,
                'normalized_text': "[REDACTED]",
                'ai_response': None,
                'original_intent': original_intent,
            }

        # Global interceptor layer - runs before any active-flow logic
        # and before fresh intent detection.
        intercepted = check_global_controls(user_message, ctx)
        if intercepted is not None:
            return intercepted

        # Edit-previous-step utility - only relevant while a flow is
        # active (including while sitting at a confirmation prompt).
        if ctx.get('current_flow'):
            edit_result = try_handle_edit_previous(user_message, ctx)
            if edit_result is not None:
                return edit_result

        # Confirmation step handling, if we're currently sitting in
        # *_AWAIT_CONFIRMATION.
        #
        # Primary signal is the round-tripped flow_state. As a safety net
        # for callers (like an unmodified app.py) that don't yet persist
        # flow_state back into session['conversation_context'], we ALSO
        # infer "we're at confirmation" whenever every slot for the
        # active flow is already filled - that's structurally only true
        # once we've reached confirmation, since run_flow_step never
        # returns with every slot filled for any other reason.
        flow_state_name = ctx.get('flow_state')
        current_flow_for_confirm_check = ctx.get('current_flow')
        all_slots_filled = (
            current_flow_for_confirm_check in FLOW_SLOT_ORDER
            and all(ctx.get(s) for s in FLOW_SLOT_ORDER[current_flow_for_confirm_check])
        )
        # NOTE: the all_slots_filled fallback must NOT override an explicit
        # TRANSFER_AWAIT_RECIPIENT flow_state. Since the pre-fill pass (see
        # _prefill_flow_slots) can now legitimately have every OTHER slot
        # (amount, description, ...) already filled while we're still
        # sitting at the recipient-confirmation gate waiting on a yes/no
        # about the looked-up name, all_slots_filled can be True at the
        # exact same time flow_state says TRANSFER_AWAIT_RECIPIENT. In that
        # case the explicit state must win, or a "yes" meant to confirm the
        # recipient's identity gets misrouted straight past it to the final
        # transaction confirmation (and from there to the password prompt).
        if (flow_state_name in (FlowState.TRANSFER_AWAIT_CONFIRMATION.name,
                                 FlowState.BILL_AWAIT_CONFIRMATION.name)
                or (all_slots_filled
                    and flow_state_name != FlowState.TRANSFER_AWAIT_RECIPIENT.name)):
            return handle_confirmation_step(user_message, ctx, language)

        # Recipient-confirmation gate (see handle_recipient_step) - must be
        # checked before the generic run_flow_step dispatch below, or a
        # "yes"/"no"/typed name here would get misinterpreted as an answer
        # for whatever slot comes after transfer_identifier (e.g. amount).
        if flow_state_name == FlowState.TRANSFER_AWAIT_RECIPIENT.name:
            return handle_recipient_step(user_message, ctx, language)

        # Active table-driven flows.
        current_flow = ctx.get('current_flow')

        if current_flow in ('transfer_money', 'pay_bill'):
            return run_flow_step(user_message, ctx, language, force_flow=current_flow)

        if current_flow == 'redeem_points':
            return self._run_redeem_points_step(user_message, ctx, language)

        intent = self.detect_intent(user_message)

        if intent == 'transfer_money':
            # 'description' defaults to "Transfer" - it's an optional field
            # in the app's transfer form, so pre-seed it rather than
            # blocking the conversation on a sixth question.
            # 'purpose' is no longer a collected slot (see FLOW_SLOT_ORDER)
            # but templates/consumers still read entities.get('purpose'),
            # so silently default it too rather than asking the user.
            base_ctx = {'description': DEFAULT_TRANSFER_DESCRIPTION,
                        'purpose': DEFAULT_TRANSFER_PURPOSE}
            # Pre-fill pass: pull as many slots as possible out of this
            # opening message (e.g. "send 400RS to 03252118947" should
            # capture the amount too, not just start the method/identifier
            # question over from scratch) - see _prefill_flow_slots.
            prefilled_ctx = _prefill_flow_slots(user_message, 'transfer_money', base_ctx)
            result = run_flow_step(user_message, prefilled_ctx,
                                   language, force_flow='transfer_money')
            result['session_language'] = language
            return result

        if intent == 'pay_bill':
            prefilled_ctx = _prefill_flow_slots(user_message, 'pay_bill', {})
            result = run_flow_step(user_message, prefilled_ctx, language, force_flow='pay_bill')
            result['session_language'] = language
            return result

        if intent == 'redeem_points':
            return {
                'intent': 'redeem_points',
                'language': language,
                'session_language': language,
                'entities': {},
                'needs_clarification': True,
                'clarification_type': 'redemption_choice_missing',
                'requires_human': False,
                'handoff_reason': None,
                'normalized_text': normalize_slang(user_message),
                'ai_response': RESPONSES['clarify_redemption_option'][language],
                'current_flow': 'redeem_points',
                'flow_state': FlowState.REDEEM_AWAIT_CHOICE.name,
            }

        if intent == 'human_agent':
            return {
                'intent': 'human_agent',
                'language': language,
                'session_language': language,
                'entities': {},
                'needs_clarification': False,
                'clarification_type': None,
                'requires_human': True,
                'handoff_reason': 'user_requested',
                'normalized_text': normalize_slang(user_message),
                'ai_response': RESPONSES['human_handoff'][language],
            }

        if intent == 'greeting':
            return {
                'intent': 'greeting',
                'language': language,
                'session_language': language,
                'entities': {},
                'needs_clarification': False,
                'clarification_type': None,
                'requires_human': False,
                'handoff_reason': None,
                'normalized_text': normalize_slang(user_message),
                'ai_response': RESPONSES['greeting'][language],
            }

        # ── Hybrid LLM Fallback ───────────────────────────────────────────────
        # Fires ONLY when regex returned 'unknown'.
        # The LLM classifies intent + extracts slots into the same shape the
        # regex would have produced, then routes into the existing state machine.
        if intent == 'unknown' and self._llm_enabled:
            llm_result = self._llm.classify(
                user_message=user_message,
                current_flow=ctx.get('current_flow'),
                flow_state=ctx.get('flow_state'),
                language=language,
            )
            llm_result = apply_confidence_gate(llm_result)
            llm_intent   = llm_result.get('intent', 'unknown')
            llm_entities = llm_result.get('entities', {})

            if llm_intent == 'transfer_money':
                transfer_ctx = dict(ctx)
                # 'description' is optional in the app's transfer form and
                # defaults to "Transfer" - pre-seed it the same way the
                # regex entry point does. Same for 'purpose', which is no
                # longer asked and is silently defaulted instead.
                transfer_ctx.setdefault('description', DEFAULT_TRANSFER_DESCRIPTION)
                transfer_ctx.setdefault('purpose', DEFAULT_TRANSFER_PURPOSE)
                result = run_flow_step(user_message, transfer_ctx, language,
                                       force_flow='transfer_money')
                result['session_language'] = language
                result['llm_used'] = True
                # NOTE: 'recipient' is intentionally excluded here. The
                # fallback LLM (see llm_fallback.py) is instructed to never
                # extract a recipient name for transfer_money/bill_payments.
                # 'transfer_identifier' (the phone number) is ALSO excluded
                # from this post-hoc merge on purpose: run_flow_step()
                # already re-runs the same phone-number regex directly
                # against user_message and, on a match, performs the
                # PostgreSQL resolution step. Patching a phone number into
                # result['entities'] here afterwards would bypass that
                # resolution entirely and leave 'recipient'/'account_number'
                # unset, so we let the regex extraction path be the single
                # source of truth for this slot.
                for key in ('amount', 'transfer_method', 'description'):
                    if llm_entities.get(key) and not result['entities'].get(key):
                        result['entities'][key] = llm_entities[key]
                return result

            if llm_intent == 'pay_bill':
                result = run_flow_step(user_message, ctx, language,
                                       force_flow='pay_bill')
                result['session_language'] = language
                result['llm_used'] = True
                for key in ('bill_category', 'service_provider', 'bill_reference', 'amount'):
                    if llm_entities.get(key) and not result['entities'].get(key):
                        result['entities'][key] = llm_entities[key]
                return result

            if llm_intent == 'general_chat':
                # LLM wrote a conversational reply (e.g. "what is a SWIFT code?")
                return {
                    'intent': 'general_chat',
                    'language': language,
                    'session_language': language,
                    'entities': {},
                    'needs_clarification': False,
                    'clarification_type': None,
                    'requires_human': False,
                    'handoff_reason': None,
                    'normalized_text': normalize_slang(user_message),
                    'ai_response': llm_result.get('ai_response'),
                    'llm_used': True,
                }

            if llm_intent not in ('unknown', 'general_chat', None):
                # LLM found a known intent — promote it so the final
                # return below uses the correct intent.
                intent = llm_intent
        # ── End Hybrid LLM Fallback ───────────────────────────────────────────# For other intents (check_balance, check_rewards,
        # transaction_history, bill_reminders, unknown), return basic
        # structure - app.py fills in the actual data-driven response.
        return {
            'intent': intent,
            'language': language,
            'session_language': language,
            'entities': {},
            'needs_clarification': False,
            'clarification_type': None,
            'requires_human': False,
            'handoff_reason': None,
            'normalized_text': normalize_slang(user_message),
            'ai_response': None,
        }

    # -- redeem_points flow (single slot, kept as a small dedicated method
    #    rather than forced into the generic 2+-slot table runner, since the
    #    redemption-choice extractor has no validator/invalid-state and the
    #    table runner's machinery would add no value here). ------------------
    def _run_redeem_points_step(self, user_message: str, ctx: Dict, language: str) -> Dict:
        if not ctx.get('redemption_choice'):
            choice = extract_redemption_choice(user_message)
            if choice:
                new_ctx = dict(ctx)
                new_ctx['redemption_choice'] = choice
                new_ctx['flow_state'] = FlowState.REDEEM_AWAIT_PASSWORD.name
                return {
                    'intent': 'redeem_points',
                    'language': language,
                    'entities': {'redemption_choice': choice},
                    'needs_clarification': True,
                    'clarification_type': 'password_required',
                    'requires_human': False,
                    'handoff_reason': None,
                    'normalized_text': normalize_slang(user_message),
                    'ai_response': RESPONSES['redeem_password_request'][language],
                    'awaiting_password': True,
                    'original_intent': 'redeem_points',
                    'pending_entities': {'redemption_choice': choice},
                    'current_flow': 'redeem_points',
                    'flow_state': FlowState.REDEEM_AWAIT_PASSWORD.name,
                }
            else:
                # Extractor returned None (e.g. "what are my
                # options?" or garbled input). Re-prompt with the choices
                # while preserving the active flow - never drop through to
                # fresh intent detection.
                return {
                    'intent': 'redeem_points',
                    'language': language,
                    'entities': {},
                    'needs_clarification': True,
                    'clarification_type': 'redemption_choice_missing',
                    'requires_human': False,
                    'handoff_reason': None,
                    'normalized_text': normalize_slang(user_message),
                    'ai_response': RESPONSES['clarify_redemption_option'][language],
                    'current_flow': 'redeem_points',
                    'flow_state': FlowState.REDEEM_AWAIT_CHOICE.name,
                }
        else:
            # redemption_choice already filled (state replay) -
            # re-issue the password prompt instead of falling through to
            # fresh intent detection.
            choice = ctx['redemption_choice']
            return {
                'intent': 'redeem_points',
                'language': language,
                'entities': {'redemption_choice': choice},
                'needs_clarification': True,
                'clarification_type': 'password_required',
                'requires_human': False,
                'handoff_reason': None,
                'normalized_text': "[REDACTED]",
                'ai_response': RESPONSES['redeem_password_request'][language],
                'awaiting_password': True,
                'original_intent': 'redeem_points',
                'pending_entities': {'redemption_choice': choice},
                'current_flow': 'redeem_points',
                'flow_state': FlowState.REDEEM_AWAIT_PASSWORD.name,
            }
