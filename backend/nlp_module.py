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
    TRANSFER_AWAIT_AMOUNT = auto()
    TRANSFER_AWAIT_RECIPIENT = auto()
    TRANSFER_AWAIT_ACCOUNT = auto()
    TRANSFER_AWAIT_CONFIRMATION = auto()
    TRANSFER_AWAIT_PASSWORD = auto()
    BILL_AWAIT_TYPE = auto()
    BILL_AWAIT_REFERENCE = auto()
    BILL_AWAIT_AMOUNT = auto()
    BILL_AWAIT_CONFIRMATION = auto()
    BILL_AWAIT_PASSWORD = auto()
    REDEEM_AWAIT_CHOICE = auto()
    REDEEM_AWAIT_PASSWORD = auto()
    EMERGENCY_AWAIT_PASSWORD = auto()


# Map FlowState -> the legacy `current_flow` string app.py already persists
# in session['conversation_context']['current_flow']. Kept as a single
# source of truth so the new engine and the old session shape never drift.
FLOW_STATE_TO_LEGACY_FLOW = {
    FlowState.TRANSFER_AWAIT_AMOUNT: 'transfer_money',
    FlowState.TRANSFER_AWAIT_RECIPIENT: 'transfer_money',
    FlowState.TRANSFER_AWAIT_ACCOUNT: 'transfer_money',
    FlowState.TRANSFER_AWAIT_CONFIRMATION: 'transfer_money',
    FlowState.BILL_AWAIT_TYPE: 'pay_bill',
    FlowState.BILL_AWAIT_REFERENCE: 'pay_bill',
    FlowState.BILL_AWAIT_AMOUNT: 'pay_bill',
    FlowState.BILL_AWAIT_CONFIRMATION: 'pay_bill',
    FlowState.REDEEM_AWAIT_CHOICE: 'redeem_points',
}

# The ordered slot sequence for each flow: given a FlowState, this defines
# which slot is being filled and what state to move to once it's filled.
# Order matters - it's also what the edit-previous-step utility walks
# backwards over.
FLOW_SLOT_ORDER = {
    'transfer_money': ['amount', 'recipient', 'account_number'],
    'pay_bill': ['bill_type', 'bill_reference', 'amount'],
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
    ('transfer_money', 'amount'): FlowState.TRANSFER_AWAIT_AMOUNT,
    ('transfer_money', 'recipient'): FlowState.TRANSFER_AWAIT_RECIPIENT,
    ('transfer_money', 'account_number'): FlowState.TRANSFER_AWAIT_ACCOUNT,
    ('pay_bill', 'bill_type'): FlowState.BILL_AWAIT_TYPE,
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
        # Urdu script
        r'کارڈ\s*(بلاک|لاک|بند)\s*(کر[وؤ])?',
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
    r'^\s*confirm(ed)?\s*$', r'^\s*ok(ay)?\s*$', r'^\s*haan\s*ji?\s*$',
    r'^\s*ji\s*haan\s*$', r'^\s*g\s*$', r'^\s*sahi\s*hai\s*$',
    r'^\s*theek\s*hai\s*$', r'^\s*proceed\s*$',
]
NEGATIVE_PATTERNS = [
    r'^\s*no\s*$', r'^\s*n\s*$', r'^\s*nah\s*$', r'^\s*nahi\s*n?\s*$',
    r'^\s*nope\s*$', r'^\s*cancel\s*$', r'^\s*galat\s*$',
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
        'en': "Hello! I'm FinBud AI!. How can I help you today?",
        'ur': "السلام علیکم! میں FinBud AI ہوں۔ میں آپ کی کیسے مدد کر سکتا ہوں؟",
        'ru': "Assalam-o-Alaikum! Main FinBud AI! hoon. Aap ki kaise madad kar sakta hoon?"
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
    'transfer_ask_amount': {
        'en': "How much would you like to transfer?",
        'ur': "💰 آپ کتنی رقم منتقل کرنا چاہتے ہیں؟",
        'ru': "Aap kitni raqam transfer karna chahte hain?"
    },
    'transfer_ask_recipient_name': {
        'en': "👤 Who would you like to send RS {amount:,} to? Please provide their name.",
        'ur': "👤 \u200Fآپ \u2066RS {amount:,}\u2069 کسے بھیجنا چاہتے ہیں؟ براۓ کرم ان کا نام فراہم کریں۔",
        'ru': "👤 Aap RS {amount:,} kise bhejna chahte hain? Unka naam provide karein."
    },
    'transfer_ask_account': {
        'en': "Please provide the account number for {recipient}.",
        'ur': "🔢 \u200Fبراۓ کرم \u2066{recipient}\u2069 کا اکاؤنٹ نمبر فراہم کریں۔",
        'ru': "{recipient} ka account number provide karein."
    },
    'transfer_invalid_account': {
        'en': "❌ Invalid account number. Please provide a valid account number(eg; ABC12345678).",
        'ur': "❌ غلط اکاؤنٹ نمبر۔ براۓ کرم ایک درست اکاؤنٹ نمبر فراہم کریں۔",
        'ru': "❌ Ghalat account number. Brahe karam ek durust account number provide karein(maslan; ABC12345678)."
    },
    'transfer_confirm': {
        'en': "Confirm: sending RS {amount:,} to {recipient}, account {account_number} — yes/no?",
        'ur': "\u200Fتصدیق کریں: \u2066RS {amount:,}\u2069 \u2066{recipient}\u2069 کو، اکاؤنٹ \u2066{account_number}\u2069 میں بھیجنا ہے — yes/no؟",
        'ru': "Confirm karein: RS {amount:,} {recipient} ko, account {account_number} mein bhejna hai — yes/no?"
    },
    'transfer_password_request': {
        'en': "🔒 Please enter your password to confirm the transfer of RS {amount:,} to {recipient}.",
        'ur': "🔒 \u200Fبراۓ کرم اپنا پاس ورڈ درج کریں تاکہ \u2066{recipient}\u2069 کو \u2066RS {amount:,}\u2069 کی منتقلی کی تصدیق ہو سکے۔",
        'ru': "🔒 Apna password enter karein taake {recipient} ko RS {amount:,} ki transfer confirm ho sake."
    },
    'transfer_success': {
        'en': "✅ Transfer successful! RS {amount:,} sent to {recipient}.\n💰 New balance: RS {balance:,}\n⭐ You earned {points} reward points!",
        'ur': "✅ \u200Fٹرانسفر کامیاب! \u2066RS {amount:,}\u2069 \u2066{recipient}\u2069 کو بھیجا گیا۔\n💰 \u200Fنیا بیلنس: \u2066RS {balance:,}\u2069\n⭐ \u200Fآپ نے \u2066{points}\u2069 انعامی پوائنٹس حاصل کیے!",
        'ru': "✅ Transfer kamyab! RS {amount:,} {recipient} ko bheja gaya.\n💰 Naya balance: RS {balance:,}\n⭐ Aap ne {points} reward points hasil kiye!"
    },
    'bill_ask_type': {
        'en': "Which bill would you like to pay?\n• Electricity\n• Gas\n• Internet\n• Water",
        'ur': "📋 آپ کون سا بل ادا کرنا چاہتے ہیں؟\n• بجلی\n• گیس\n• انٹرنیٹ\n• پانی",
        'ru': "Aap konsa bill ada karna chahte hain?\n• Electricity\n• Gas\n• Internet\n• Water"
    },
    'bill_ask_reference': {
        'en': " Please provide your {bill_type} bill reference number.",
        'ur': "🔢 براۓ کرم اپنا {bill_type} بل ریفرنس نمبر فراہم کریں۔",
        'ru': " Apna {bill_type} bill reference number provide karein."
    },
    'bill_ask_amount': {
        'en': "How much is your {bill_type} bill amount?",
        'ur': "💵 آپ کا {bill_type} بل کتنا ہے؟",
        'ru': "Aap ka {bill_type} bill kitna hai?"
    },
    'bill_confirm': {
        'en': "Confirm: paying RS {amount:,} for your {bill_type} bill (ref {account_number}) — yes/no?",
        'ur': "تصدیق کریں: {bill_type} بل (ریف \u2066{account_number}\u2069) کے لیے \u2066RS {amount:,}\u2069 ادا کرنا ہے — yes/no؟",
        'ru': "Confirm karein: {bill_type} bill (ref {account_number}) ke liye RS {amount:,} pay karna hai — yes/no?"
    },
    'bill_payment_password_request': {
        'en': "🔒 Please enter your password to confirm the {bill_type} bill payment of RS {amount:,}.",
        'ur': "🔒 براۓ کرم اپنا پاس ورڈ درج کریں تاکہ {bill_type} بل \u2066RS {amount:,}\u2069 کی ادائیگی کی تصدیق ہو سکے۔",
        'ru': "🔒 Apna password enter karein taake {bill_type} bill RS {amount:,} ki payment confirm ho sake."
    },
    'bill_payment_success': {
        'en': "✅ Bill payment successful! {bill_type} bill of RS {amount:,} paid.\n💰 New balance: RS {balance:,}\n⭐ You earned {points} reward points!",
        'ur': "✅ بل ادائیگی کامیاب! {bill_type} بل \u2066RS {amount:,}\u2069 ادا کیا گیا۔\n💰 نیا بیلنس: \u2066RS {balance:,}\u2069\n⭐ آپ نے \u2066{points}\u2069 انعامی پوائنٹس حاصل کیے!",
        'ru': "✅ Bill payment kamyab! {bill_type} bill RS {amount:,} ada kiya gaya.\n💰 Naya balance: RS {balance:,}\n⭐ Aap ne {points} reward points hasil kiye!"
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
        'en': "Connecting you to a human banker...",
        'ur': "آپ کو بینکر سے جوڑا جا رہا ہے...",
        'ru': "Aap ko banker se joda ja raha hai..."
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
    'edit_reprompt_recipient': {
        'en': "Got it - who should this go to instead?",
        'ur': "ٹھیک ہے - یہ کسے بھیجنا ہے؟",
        'ru': "Theek hai - yeh kise bhejna hai?"
    },
    'edit_reprompt_account_number': {
        'en': "Sure - what's the correct account number?",
        'ur': "ٹھیک ہے - درست اکاؤنٹ نمبر کیا ہے؟",
        'ru': "Theek hai - sahi account number kya hai?"
    },
    'edit_reprompt_bill_type': {
        'en': "Okay - which bill type should it be?",
        'ur': "ٹھیک ہے - بل کی قسم کیا ہونی چاہیے؟",
        'ru': "Theek hai - bill type kya hona chahiye?"
    },
    'edit_reprompt_bill_reference': {
        'en': "Sure - what's the correct bill reference number?",
        'ur': "ٹھیک ہے - درست بل ریفرنس نمبر کیا ہے؟",
        'ru': "Theek hai - sahi bill reference number kya hai?"
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
    'help_transfer_recipient': {
        'en': "Type the name of the person you'd like to send money to.",
        'ur': "اس شخص کا نام لکھیں جسے آپ پیسے بھیجنا چاہتے ہیں۔",
        'ru': "Us shakhs ka naam type karein jise aap paisa bhejna chahte hain."
    },
    'help_transfer_account': {
        'en': "Type the recipient's account number - a mix of letters and numbers, 6-20 characters (e.g. ABC12345678).",
        'ur': "وصول کنندہ کا اکاؤنٹ نمبر لکھیں - حروف اور ہندسوں کا مرکب، 6 سے 20 حروف (مثلاً ABC12345678)۔",
        'ru': "Recipient ka account number type karein - letters aur numbers ka mix, 6-20 characters (maslan ABC12345678)."
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
    'help_bill_reference': {
        'en': "Type your bill's reference number, found on your bill statement.",
        'ur': "اپنے بل کا ریفرنس نمبر لکھیں، جو آپ کے بل سٹیٹمنٹ پر موجود ہے۔",
        'ru': "Apne bill ka reference number type karein, jo bill statement par hota hai."
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
    if len(meaningful) == 1 and meaningful[0] in {'haan', 'nahi', 'ji', 'theek', 'sahi', 'galat'}:
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


def extract_bill_reference(text: str) -> Optional[str]:
    """Extract bill reference number — accepts anything reasonable.

    Eastern Arabic-Indic digits are translated to ASCII first,
    before the cleanup regex runs, so native-digit reference numbers are
    never silently stripped.

    Strip common Urdu and English label/filler phrases before
    collapsing to alphanumeric, so "mera reference number hay ABC13346"
    yields "ABC13346" and not "MERAHAYABC13346".
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

    # Try to isolate a clean alphanumeric reference token first
    # (look for a contiguous block of letters+digits, 4–20 chars)
    tokens = re.findall(r'[A-Z0-9]{4,20}', text.upper())
    if tokens:
        # Prefer the longest token (most likely to be the actual reference)
        return max(tokens, key=len)

    cleaned = re.sub(r'[^A-Z0-9]', '', text.upper())
    if 4 <= len(cleaned) <= 20:
        return cleaned

    if len(text) >= 4:
        return text.upper().replace(' ', '')

    return None


def extract_redemption_choice(text: str) -> Optional[int]:
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
    'amount': Slot(
        name='amount',
        extractor=extract_amount,
        on_missing_response_key='transfer_ask_amount',
    ),
    'recipient': Slot(
        name='recipient',
        extractor=extract_recipient_name_for_transfer_followup,
        on_missing_response_key='transfer_ask_recipient_name',
    ),
    'account_number': Slot(
        name='account_number',
        extractor=validate_account_number,
        on_missing_response_key='transfer_ask_account',
        on_invalid_response_key='transfer_invalid_account',
    ),
}

BILL_SLOTS = {
    'bill_type': Slot(
        name='bill_type',
        extractor=extract_bill_type,
        on_missing_response_key='bill_ask_type',
    ),
    'bill_reference': Slot(
        name='bill_reference',
        extractor=extract_bill_reference,
        on_missing_response_key='bill_ask_reference',
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
    ('transfer_money', 'amount'): 'help_transfer_amount',
    ('transfer_money', 'recipient'): 'help_transfer_recipient',
    ('transfer_money', 'account_number'): 'help_transfer_account',
    ('pay_bill', 'bill_type'): 'help_bill_type',
    ('pay_bill', 'bill_reference'): 'help_bill_reference',
    ('pay_bill', 'amount'): 'help_bill_amount',
}

# Legacy clarification_type strings (matching the contract app.py /
# any consumer might already pattern-match on) for each slot's "missing"
# case. Falls back to f'{slot}_missing' for any slot not listed here.
CLARIFICATION_TYPE_FOR_SLOT = {
    'amount': 'amount_missing',
    'recipient': 'recipient_name_missing',
    'account_number': 'account_number_missing',
    'bill_type': 'bill_type_missing',
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
    for key in ('amount', 'recipient', 'account_number', 'bill_type',
                'bill_reference', 'redemption_choice'):
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


def _render_confirmation_prompt(current_flow: str, ctx: Dict, language: str) -> str:
    if current_flow == 'transfer_money':
        return RESPONSES['transfer_confirm'][language].format(
            amount=ctx['amount'], recipient=ctx['recipient'],
            account_number=ctx['account_number'],
        )
    else:
        return RESPONSES['bill_confirm'][language].format(
            amount=ctx['amount'], bill_type=ctx['bill_type'],
            account_number=ctx['bill_reference'],
        )


def _enter_password_state(current_flow: str, ctx: Dict, language: str) -> Dict:
    """Transition from confirmation into password collection - identical
    payload shape to what app.py already expects under awaiting_password."""
    if current_flow == 'transfer_money':
        amount, recipient, account_number = ctx['amount'], ctx['recipient'], ctx['account_number']
        pending_entities = {'amount': amount, 'recipient': recipient, 'account_number': account_number}
        ai_response = RESPONSES['transfer_password_request'][language].format(
            amount=amount, recipient=recipient,
        )
    else:
        bill_type, bill_reference, amount = ctx['bill_type'], ctx['bill_reference'], ctx['amount']
        pending_entities = {'bill_type': bill_type, 'account_number': bill_reference, 'amount': amount}
        ai_response = RESPONSES['bill_payment_password_request'][language].format(
            bill_type=bill_type, amount=amount,
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


def run_flow_step(user_message: str, ctx: Dict, language: str,
                   force_flow: Optional[str] = None,
                   skip_extraction: bool = False) -> Dict:
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

        result = {
            'intent': current_flow,
            'language': effective_language,
            'session_language': ctx.get('session_language', language),
            'entities': {k: new_ctx[k] for k in slot_order},
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
        extracted = slot_def.extractor(user_message)
    except Exception:
        extracted = None

    # Special-case the very first slot of transfer_money: try to also pull
    # the recipient out of the same message.
    if (current_flow == 'transfer_money' and target_slot == 'amount'
            and extracted is not None):
        result = _start_transfer_with_amount(user_message, extracted, effective_language)
        result['session_language'] = ctx.get('session_language', language)
        return result

    if slot_def.validator and extracted is not None and not slot_def.validator(extracted):
        extracted = None

    if extracted is None:
        response_key = (
            slot_def.on_invalid_response_key
            if (slot_def.on_invalid_response_key and user_message.strip())
            else slot_def.on_missing_response_key
        )
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
                if response_key == slot_def.on_missing_response_key
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
        return result

    # Slot filled successfully - advance.
    new_ctx = dict(ctx)
    new_ctx[target_slot] = extracted
    new_ctx['current_flow'] = current_flow
    return run_flow_step(user_message="", ctx=new_ctx, language=language,
                          force_flow=current_flow, skip_extraction=False)


def _format_with_ctx(template: str, ctx: Dict) -> str:
    """Format a response template using whatever flow fields are already
    in ctx (amount/recipient/bill_type/etc.), tolerating missing keys."""
    try:
        return template.format(**ctx)
    except (KeyError, IndexError):
        return template


def _start_transfer_with_amount(user_message: str, amount: int, language: str) -> Dict:
    """
    Mirrors the top-level transfer_money intent
    entry point: once an amount is found, also try to pull the recipient
    out of the SAME message (e.g. "Ahmed ko 300 bhejdo") instead of always
    re-asking for a name the user already gave.
    """
    text_without_amount = strip_amount_substring(user_message)
    recipient = extract_recipient_name_for_transfer_followup(text_without_amount)

    if recipient:
        return {
            'intent': 'transfer_money',
            'language': language,
            'entities': {'amount': amount, 'recipient': recipient},
            'needs_clarification': True,
            'clarification_type': 'account_number_missing',
            'requires_human': False,
            'handoff_reason': None,
            'normalized_text': normalize_slang(user_message),
            'ai_response': RESPONSES['transfer_ask_account'][language].format(recipient=recipient),
            'current_flow': 'transfer_money',
            'flow_state': FlowState.TRANSFER_AWAIT_ACCOUNT.name,
            'amount': amount,
            'recipient': recipient,
        }

    return {
        'intent': 'transfer_money',
        'language': language,
        'entities': {'amount': amount},
        'needs_clarification': True,
        'clarification_type': 'recipient_name_missing',
        'requires_human': False,
        'handoff_reason': None,
        'normalized_text': normalize_slang(user_message),
        'ai_response': RESPONSES['transfer_ask_recipient_name'][language].format(amount=amount),
        'current_flow': 'transfer_money',
        'flow_state': FlowState.TRANSFER_AWAIT_RECIPIENT.name,
        'amount': amount,
    }


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
                # Cheaper option: model="openai/gpt-oss-120b"
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
        # set - see its docstring).
        emergency_intercept = None
        if ctx.get('awaiting_password') or ctx.get('awaiting_emergency_password'):
            normalized_check = normalize_slang(user_message)
            if _matches_any(normalized_check, INTENT_PATTERNS['emergency']):
                emergency_intercept = check_global_controls(user_message, ctx)

        if emergency_intercept is not None:
            return emergency_intercept

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
        if (flow_state_name in (FlowState.TRANSFER_AWAIT_CONFIRMATION.name,
                                 FlowState.BILL_AWAIT_CONFIRMATION.name)
                or all_slots_filled):
            return handle_confirmation_step(user_message, ctx, language)

        # Active table-driven flows.
        current_flow = ctx.get('current_flow')

        if current_flow in ('transfer_money', 'pay_bill'):
            return run_flow_step(user_message, ctx, language, force_flow=current_flow)

        if current_flow == 'redeem_points':
            return self._run_redeem_points_step(user_message, ctx, language)

        intent = self.detect_intent(user_message)

        if intent == 'transfer_money':
            result = run_flow_step(user_message, {}, language, force_flow='transfer_money')
            result['session_language'] = language
            return result

        if intent == 'pay_bill':
            result = run_flow_step(user_message, {}, language, force_flow='pay_bill')
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
                result = run_flow_step(user_message, ctx, language,
                                       force_flow='transfer_money')
                result['session_language'] = language
                result['llm_used'] = True
                for key in ('amount', 'recipient'):
                    if llm_entities.get(key) and not result['entities'].get(key):
                        result['entities'][key] = llm_entities[key]
                return result

            if llm_intent == 'pay_bill':
                result = run_flow_step(user_message, ctx, language,
                                       force_flow='pay_bill')
                result['session_language'] = language
                result['llm_used'] = True
                if llm_entities.get('bill_type') and not result['entities'].get('bill_type'):
                    result['entities']['bill_type'] = llm_entities['bill_type']
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
