"""
llm_fallback.py  —  FinBud AI: Hybrid LLM Fallback Layer
==========================================================

This module is called by nlp_module.py ONLY when the regex engine
returns intent='unknown' OR when a slot extractor returns None during
an active flow.


It uses OpenAI (via Groq API) to:
  1. Classify the intent from the same set of intents the regex uses
  2. Extract slot values (amount, phone_number, account_number, etc.)
     — NEVER a recipient/payee name for transfer_money or bill_payments
  3. Generate a conversational reply when neither regex nor a known
     banking intent applies (e.g. "what is a SWIFT code?")

The LLM output is ALWAYS validated before it touches the state machine.
The LLM can never skip a confirmation step, bypass a password, or
directly trigger a financial transaction.

Setup:
  pip install groq

  Then set your environment variable:
    export GROQ_API_KEY="your_key_here"

  OR pass it directly when constructing LLMFallback(api_key="...").
"""

import os
import json
import re
import logging
from typing import Optional

# ── install with:  pip install groq ──────────────────────────────────────────
try:
    from groq import Groq
    GROQ_AVAILABLE = True
except ImportError:
    GROQ_AVAILABLE = False

logger = logging.getLogger(__name__)

# ── Constants ─────────────────────────────────────────────────────────────────

# The exact intent names the regex engine already uses.
# The LLM must only return one of these (or 'unknown' / 'general_chat').
VALID_INTENTS = [
    'check_balance',
    'transfer_money',
    'pay_bill',
    'transaction_history',
    'redeem_points',
    'check_rewards',
    'bill_reminders',
    'emergency',
    'human_agent',
    'greeting',
    'unknown',
    'general_chat',   # NEW: for conversational replies the regex has no template for
]

# Valid slot keys the LLM is allowed to extract.
# NOTE: 'recipient' is intentionally NOT here. For transfer_money and
# bill_payments, the LLM must never extract, guess, or be asked for a
# recipient/payee name - only the target phone number and amount. The
# recipient's name is always resolved server-side via a PostgreSQL lookup
# on the phone number (see nlp_module.set_recipient_resolver /
# app.py:lookup_account_by_phone), never taken from free text.
VALID_SLOT_KEYS = {
    'amount',
    'phone_number',
    'account_number',
    'bill_type',
    'bill_reference',
    'redemption_choice',
}

VALID_BILL_TYPES = {'electricity', 'gas', 'water', 'internet', 'ptcl'}

# Pakistani mobile number, local or international, optionally with
# spaces/dashes - mirrors nlp_module.extract_phone_number_pk()'s format.
PK_PHONE_RE = re.compile(r'(?:0092|92|0)?3\d{9}$')

# Amount guard rails — anything outside this range is rejected
AMOUNT_MIN = 1
AMOUNT_MAX = 5_000_000

# ── The system prompt sent to Llama 3 ────────────────────────────────────────
# This is the single most important thing to get right.
# It tells the LLM exactly what shape to reply in and what it must not do.

SYSTEM_PROMPT = """You are a backend parser for FinBud AI, a multilingual Pakistani banking chatbot.

The chatbot supports English, Urdu, and Roman Urdu (Urdu written in Latin script).

This app serves Pakistan ONLY. Never use the ₹ (Indian Rupee) symbol or refer to
India/Indian Rupees under any circumstance. Always denote currency as "Rs" or "PKR"
(e.g. "Rs 5,000" or "PKR 5,000"). Do not generate content related to any other
country's currency or financial systems.

Your ONLY job is to parse user messages and return a JSON object.
Do NOT write any explanation. Do NOT include markdown. Return raw JSON only.

──────────────────────────────────────────────
JSON SCHEMA YOU MUST RETURN (always all keys present):
{
  "intent": "<one of the valid intents below>",
  "entities": {
    "amount": <integer rupees or null>,
    "phone_number": "<string Pakistani mobile number or null>",
    "account_number": "<string or null>",
    "bill_type": "<electricity|gas|water|internet|ptcl or null>",
    "bill_reference": "<string or null>",
    "redemption_choice": <1 or 2 or null>
  },
  "confidence": <0.0 to 1.0>,
  "conversational_reply": "<string reply in the same language the user wrote in, or null>"
}
──────────────────────────────────────────────

VALID INTENTS:
- check_balance      → user wants to see their account balance
- transfer_money     → user wants to send money to someone
- pay_bill           → user wants to pay an electricity, gas, water or internet bill
- transaction_history → user wants to see past transactions
- redeem_points      → user wants to use/redeem their reward points
- check_rewards      → user wants to know how many reward points they have
- bill_reminders     → user wants to see upcoming or pending bills
- emergency          → user wants to block/lock their card, or reports theft/fraud
- human_agent        → user wants to talk to a human customer service agent
- greeting           → user is just saying hello
- general_chat       → user asked a banking-related question that doesn't map to any intent above
                        (e.g. "what is a SWIFT code?", "how does online banking work?")
                        — in this case, set conversational_reply to a helpful answer
- unknown            → you genuinely cannot determine what the user wants

RULES:
1. Return raw JSON only. No markdown. No explanation.
2. Set confidence between 0.0 and 1.0 based on how sure you are.
3. For amount: extract the number in Pakistani Rupees as an integer. Understand:
   - "5 hajar" = 5000, "do lakh" = 200000, "paanch sau" = 500
   - Ignore decimal amounts for banking transactions.
4. For transfer_money and pay_bill: extract ONLY a phone number into
   "phone_number" (Pakistani mobile format, e.g. 03001234567 or
   +923001234567). NEVER extract, guess, or return a person's name for
   any field, under any circumstance - not into "phone_number", not into
   any other key, and not into "conversational_reply" either. The
   recipient's identity is looked up server-side from the phone number;
   you are not responsible for identifying who the money is going to, and
   must not attempt to.
5. For bill_type: map all variants (bijli/bijlee/electricity → electricity, pani/paani → water, etc.)
6. For conversational_reply: ONLY populate this when intent is "general_chat".
   Write the reply in the SAME language the user used (English / Urdu / Roman Urdu).
   Keep the tone warm and friendly, like a helpful human assistant, not stiff or robotic.
7. If a field is not present in the user message, set it to null.
8. NEVER set intent to a payment/transfer action based on ambiguous input.
   When in doubt, prefer "unknown" over a financial intent.
"""


class LLMFallback:
    """
    Wraps the Groq/Llama-3 API call. Constructed once at app startup
    and then called via .classify() for every regex miss.
    """

    def __init__(self, api_key: str = None, model: str = "openai/gpt-oss-120b"):
        """
        api_key : your Groq API key (falls back to GROQ_API_KEY env var)
        model   : Groq model ID — openai/gpt-oss-120b is the best
                  balance of quality + speed for this task.
                  Cheaper alternative: "llama-3.1-8b-instant"
        """
        if not GROQ_AVAILABLE:
            raise ImportError(
                "groq package not installed. Run: pip install groq"
            )

        self.model = model
        self.client = Groq(api_key=api_key or os.environ.get("GROQ_API_KEY"))

    # ── Main entry point ──────────────────────────────────────────────────────

    def classify(
        self,
        user_message: str,
        current_flow: str = None,
        flow_state: str = None,
        language: str = 'en',
    ) -> dict:
        """
        Send the user message to Llama 3 and return a VALIDATED structured dict.

        Parameters
        ----------
        user_message  : raw text from the user
        current_flow  : e.g. 'transfer_money' — gives the LLM context about
                        which slot it's currently trying to fill
        flow_state    : e.g. 'TRANSFER_AWAIT_IDENTIFIER' — finer context
        language      : 'en' | 'ur' | 'ru' — drives reply language instruction

        Returns
        -------
        {
            'intent'       : str,
            'entities'     : dict,
            'confidence'   : float,
            'ai_response'  : str or None,
            'llm_used'     : True,
            'error'        : str or None   ← only present when something failed
        }
        """
        # Build a user prompt that tells the LLM what context it's in
        user_prompt = self._build_user_prompt(
            user_message, current_flow, flow_state, language
        )

        raw_llm_output = self._call_groq(user_prompt)
        if raw_llm_output is None:
            return self._fallback_error_result("LLM call failed or timed out")

        parsed = self._parse_json(raw_llm_output)
        if parsed is None:
            return self._fallback_error_result("LLM returned invalid JSON")

        validated = self._validate(parsed)
        return validated

    # ── Internal helpers ──────────────────────────────────────────────────────

    def _build_user_prompt(
        self,
        user_message: str,
        current_flow: str,
        flow_state: str,
        language: str,
    ) -> str:
        """
        Construct the user-side prompt. The more context we give the LLM
        here, the better its slot extraction is.
        """
        context_lines = []

        if current_flow:
            context_lines.append(f"ACTIVE FLOW: {current_flow}")
        if flow_state:
            context_lines.append(f"AWAITING SLOT: {flow_state}")

        lang_instructions = {
            'en': "Reply language for conversational_reply: English",
            'ur': "Reply language for conversational_reply: Urdu script",
            'ru': "Reply language for conversational_reply: Roman Urdu (Urdu in Latin script)",
        }
        context_lines.append(lang_instructions.get(language, lang_instructions['en']))

        context_block = "\n".join(context_lines)

        return (
            f"{context_block}\n\n"
            f"USER MESSAGE:\n{user_message}\n\n"
            f"Parse the above and return the JSON."
        )

    def _call_groq(self, user_prompt: str) -> Optional[str]:
        """
        Make the actual API call. Returns raw string output or None on error.
        """
        try:
            response = self.client.chat.completions.create(
                model=self.model,
                messages=[
                    {"role": "system", "content": SYSTEM_PROMPT},
                    {"role": "user",   "content": user_prompt},
                ],
                temperature=0.0,       # Deterministic — we want consistent extraction
                max_tokens=400,        # Enough for the JSON + reply, not more
                response_format={"type": "json_object"},  # Force JSON output
            )
            return response.choices[0].message.content

        except Exception as exc:
            logger.error("Groq API call failed: %s", exc)
            return None

    def _parse_json(self, raw: str) -> Optional[dict]:
        """
        Parse the LLM's JSON string. Strips markdown fences just in case
        the model ignores the json_object format instruction.
        """
        # Strip any ```json ... ``` wrapping
        cleaned = re.sub(r'^```(?:json)?\s*', '', raw.strip(), flags=re.IGNORECASE)
        cleaned = re.sub(r'\s*```$', '', cleaned.strip())

        try:
            return json.loads(cleaned)
        except json.JSONDecodeError as exc:
            logger.warning("JSON parse failed: %s | raw: %.200s", exc, raw)
            return None

    def _validate(self, parsed: dict) -> dict:
        """
        Validate and sanitize every field the LLM returned.
        Any field that fails validation is set to None/null rather than
        letting a bad value reach the state machine.
        """
        # ── intent ────────────────────────────────────────────────────────────
        intent = parsed.get('intent', 'unknown')
        if intent not in VALID_INTENTS:
            logger.warning("LLM returned unknown intent '%s', defaulting to 'unknown'", intent)
            intent = 'unknown'

        # ── confidence ────────────────────────────────────────────────────────
        try:
            confidence = float(parsed.get('confidence', 0.0))
            confidence = max(0.0, min(1.0, confidence))
        except (TypeError, ValueError):
            confidence = 0.0

        # ── entities ──────────────────────────────────────────────────────────
        raw_entities = parsed.get('entities', {})
        if not isinstance(raw_entities, dict):
            raw_entities = {}

        entities = {}

        # amount
        raw_amount = raw_entities.get('amount')
        if raw_amount is not None:
            try:
                amount = int(raw_amount)
                if AMOUNT_MIN <= amount <= AMOUNT_MAX:
                    entities['amount'] = amount
                else:
                    logger.warning(
                        "LLM amount %d outside allowed range [%d, %d], discarded",
                        amount, AMOUNT_MIN, AMOUNT_MAX
                    )
            except (TypeError, ValueError):
                logger.warning("LLM amount '%s' is not an integer, discarded", raw_amount)

        # phone_number (transfer_money / pay_bill target) — the ONLY way a
        # transfer/bill-payment target may be identified. A recipient NAME
        # is never accepted here even if the LLM mistakenly returns one:
        # we validate strictly against the Pakistani mobile number shape
        # and silently discard anything that doesn't match, rather than
        # letting a name slip through under this key.
        raw_phone = raw_entities.get('phone_number')
        if raw_phone and isinstance(raw_phone, str):
            digits_only = re.sub(r'[^\d]', '', raw_phone.strip())
            if PK_PHONE_RE.fullmatch(digits_only):
                # Normalize to local 03XXXXXXXXX form.
                local_digits = digits_only[-10:]
                entities['phone_number'] = '0' + local_digits

        # account_number
        raw_acc = raw_entities.get('account_number')
        if raw_acc and isinstance(raw_acc, str):
            # Basic sanity: at least 6 alphanumeric characters
            cleaned_acc = re.sub(r'\s+', '', raw_acc.strip().upper())
            if re.fullmatch(r'[A-Z0-9]{6,20}', cleaned_acc):
                entities['account_number'] = cleaned_acc

        # bill_type
        raw_bill_type = raw_entities.get('bill_type')
        if raw_bill_type and isinstance(raw_bill_type, str):
            bt = raw_bill_type.strip().lower()
            if bt in VALID_BILL_TYPES:
                entities['bill_type'] = bt

        # bill_reference
        raw_ref = raw_entities.get('bill_reference')
        if raw_ref and isinstance(raw_ref, str):
            cleaned_ref = re.sub(r'\s+', '', raw_ref.strip().upper())
            if re.fullmatch(r'[A-Z0-9]{4,20}', cleaned_ref):
                entities['bill_reference'] = cleaned_ref

        # redemption_choice
        raw_choice = raw_entities.get('redemption_choice')
        if raw_choice in (1, 2):
            entities['redemption_choice'] = int(raw_choice)

        # ── conversational_reply ──────────────────────────────────────────────
        # Only accepted when intent == 'general_chat'.
        # Rejected for ANY financial intent — the LLM must not compose
        # transaction confirmations or payment summaries.
        ai_response = None
        if intent == 'general_chat':
            raw_reply = parsed.get('conversational_reply')
            if raw_reply and isinstance(raw_reply, str) and raw_reply.strip():
                ai_response = raw_reply.strip()

        return {
            'intent':      intent,
            'entities':    entities,
            'confidence':  confidence,
            'ai_response': ai_response,
            'llm_used':    True,
            'error':       None,
        }

    @staticmethod
    def _fallback_error_result(reason: str) -> dict:
        """
        What to return when the LLM call itself fails.
        The caller (nlp_module.py) will treat this as intent='unknown'.
        """
        logger.error("LLM fallback failed: %s", reason)
        return {
            'intent':      'unknown',
            'entities':    {},
            'confidence':  0.0,
            'ai_response': None,
            'llm_used':    True,
            'error':       reason,
        }


# ── Confidence thresholds ─────────────────────────────────────────────────────

# If LLM confidence is below this, treat it as 'unknown' even if it returned
# a valid intent. Prevents low-confidence financial intents from proceeding.
MIN_CONFIDENCE_FOR_FINANCIAL_INTENT = 0.75

# For non-financial intents (check_balance, check_rewards, etc.),
# a lower bar is acceptable since the cost of a wrong classification is lower.
MIN_CONFIDENCE_FOR_INFO_INTENT = 0.50

FINANCIAL_INTENTS = {'transfer_money', 'pay_bill', 'redeem_points', 'emergency'}


def apply_confidence_gate(llm_result: dict) -> dict:
    """
    Called by nlp_module.py after .classify() returns.
    Downgrades low-confidence financial intents to 'unknown' so the
    state machine never starts a transaction on a guess.
    """
    intent = llm_result.get('intent', 'unknown')
    confidence = llm_result.get('confidence', 0.0)

    if intent in FINANCIAL_INTENTS and confidence < MIN_CONFIDENCE_FOR_FINANCIAL_INTENT:
        logger.info(
            "Confidence gate: downgraded '%s' (%.2f) → 'unknown'", intent, confidence
        )
        llm_result = dict(llm_result)
        llm_result['intent'] = 'unknown'
        llm_result['entities'] = {}

    elif intent not in FINANCIAL_INTENTS | {'unknown', 'general_chat', 'greeting'} \
            and confidence < MIN_CONFIDENCE_FOR_INFO_INTENT:
        llm_result = dict(llm_result)
        llm_result['intent'] = 'unknown'

    return llm_result


# ── Urdu-script → Roman Urdu transliteration ───────────────────────────────
#
# Used by the voice pipeline: browsers' native Web Speech STT can only
# return native-script Urdu transcripts (there's no "ur-Latn-PK" locale
# supported anywhere), but this app's NLP layer (detect_language() /
# SLANG_MAPPING in nlp_module.py) is built around Roman Urdu. This function
# converts the STT output before it's sent to the chat pipeline.
#
# IMPORTANT: this is a phonetic TRANSLITERATION, never a translation.
# "میرا بیلنس کیا ہے" must become "mera balance kya hai", never an English
# paraphrase like "what is my balance".

TRANSLITERATION_SYSTEM_PROMPT = """You are a phonetic transliteration engine for a Pakistani banking chatbot.

Your ONLY job: convert Urdu-script text into Roman Urdu (Urdu written in Latin/English letters), preserving the original meaning and word order EXACTLY.

Rules:
1. This is TRANSLITERATION, not translation. Do not paraphrase, summarize, or change meaning. Every word must be converted phonetically, not swapped for an English equivalent.
2. Preserve all numbers, amounts, phone numbers, and account/reference numbers EXACTLY as digits - never spell them out or alter them.
3. Match these house spelling conventions (used throughout this app) wherever the word appears:
   aap, main, hai, hain, hoon, kya, bhejo, bhejdo, bhejna, kitna, kitne,
   mera, meri, mere, mujhe, karo, karna, kardo, karein, batao, chahiye,
   bijli, pani, paisa, paise, rupay, rupaye, khata, theek, sahi, galat,
   nahi, haan, ji, shukriya, salam.
4. Output ONLY the transliterated Roman Urdu text. No quotes, no explanation, no preamble, no markdown.
5. If the input contains a mix of Urdu script and already-Latin text (e.g. an English word or a number), keep the Latin/numeric parts unchanged and only transliterate the Urdu-script parts.

Respond with the transliterated text and nothing else."""


def transliterate_urdu_to_roman(
    urdu_text: str,
    api_key: str = None,
    model: str = "openai/gpt-oss-120b",
) -> Optional[str]:
    """Transliterate Urdu-script text to Roman Urdu using the LLM.

    Must NOT translate meaning — phonetic transliteration only, matching
    the Roman Urdu conventions already used elsewhere in this app (see
    roman_words / SLANG_MAPPING in nlp_module.py for the house spelling
    conventions, e.g. 'theek' not 'thik', 'bhejo' not 'bhejjo').

    Returns None (rather than raising) on any failure, so callers — the
    voice pipeline in particular — can fall back to the raw Urdu-script
    transcript instead of blocking the conversation.
    """
    if not urdu_text or not urdu_text.strip():
        return None

    if not GROQ_AVAILABLE:
        logger.warning("Transliteration skipped: groq package not installed.")
        return None

    try:
        client = Groq(api_key=api_key or os.environ.get("GROQ_API_KEY"))
        response = client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": TRANSLITERATION_SYSTEM_PROMPT},
                {"role": "user", "content": urdu_text},
            ],
            temperature=0.0,
            max_tokens=200,
        )
        result = response.choices[0].message.content
        if result:
            return result.strip()
        return None
    except Exception as exc:
        logger.error("Urdu transliteration call failed: %s", exc)
        return None


# ── Roman Urdu → Urdu-script transliteration ────────────────────────────────
#
# Used by the voice pipeline in the OTHER direction from the function above:
# to speak a reply aloud with a genuine Urdu voice/accent (see
# /api/voice/synthesize in app.py), the text-to-speech engine needs real
# Urdu-script input. Feeding it Roman Urdu ("aap ka balance kya hai") makes
# TTS engines read it with English/default pronunciation rules, which is
# exactly the "wrong accent" bug this exists to fix - so Roman Urdu replies
# are converted to Urdu script here first, then handed to TTS.
#
# IMPORTANT: same rule as above - phonetic TRANSLITERATION only, never a
# translation. "mera balance kya hai" must become "میرا بیلنس کیا ہے", never
# an English paraphrase.

ROMAN_TO_URDU_SCRIPT_SYSTEM_PROMPT = """You are a phonetic transliteration engine for a Pakistani banking chatbot.

Your ONLY job: convert Roman Urdu text (Urdu written in Latin/English letters) into Urdu script (Nastaliq/Arabic script), preserving the original meaning and word order EXACTLY.

Rules:
1. This is TRANSLITERATION, not translation. Do not paraphrase, summarize, or change meaning. Every word must be converted phonetically into Urdu script, not swapped for a different word.
2. Preserve all numbers, amounts, phone numbers, and account/reference numbers EXACTLY as digits - never spell them out or alter them.
3. Keep any already-English words (brand names, "OK", "PIN", etc.) as-is in Latin script if converting them to Urdu script would be unnatural; otherwise transliterate them into Urdu script too.
4. Output ONLY the Urdu-script text. No quotes, no explanation, no preamble, no markdown.
5. If the input contains a mix of Roman Urdu and plain English sentences, transliterate the Roman Urdu parts into Urdu script and keep genuine English parts in Latin script.

Respond with the transliterated Urdu-script text and nothing else."""


def transliterate_roman_to_urdu_script(
    roman_text: str,
    api_key: str = None,
    model: str = "openai/gpt-oss-120b",
) -> Optional[str]:
    """Transliterate Roman Urdu text to Urdu script using the LLM.

    Mirrors transliterate_urdu_to_roman() but runs in the opposite
    direction, so replies can be read aloud with a proper Urdu-accented
    voice instead of the default English voice mispronouncing Roman Urdu.

    Returns None (rather than raising) on any failure, so callers - the
    voice-synthesis endpoint in particular - can fall back to a
    browser-native voice instead of blocking the reply.
    """
    if not roman_text or not roman_text.strip():
        return None

    if not GROQ_AVAILABLE:
        logger.warning("Reverse transliteration skipped: groq package not installed.")
        return None

    try:
        client = Groq(api_key=api_key or os.environ.get("GROQ_API_KEY"))
        response = client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": ROMAN_TO_URDU_SCRIPT_SYSTEM_PROMPT},
                {"role": "user", "content": roman_text},
            ],
            temperature=0.0,
            max_tokens=300,
        )
        result = response.choices[0].message.content
        if result:
            return result.strip()
        return None
    except Exception as exc:
        logger.error("Roman-to-Urdu-script transliteration call failed: %s", exc)
        return None