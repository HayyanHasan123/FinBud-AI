"""
llm_fallback.py  —  FinBud AI: Hybrid LLM Fallback Layer
==========================================================

This module is called by nlp_module.py ONLY when the regex engine
returns intent='unknown' OR when a slot extractor returns None during
an active flow.

It uses Llama 3 (via Groq API) to:
  1. Classify the intent from the same set of intents the regex uses
  2. Extract slot values (amount, recipient, account_number, etc.)
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

# Valid slot keys the LLM is allowed to extract
VALID_SLOT_KEYS = {
    'amount',
    'recipient',
    'account_number',
    'bill_type',
    'bill_reference',
    'redemption_choice',
}

VALID_BILL_TYPES = {'electricity', 'gas', 'water', 'internet', 'ptcl'}

# Amount guard rails — anything outside this range is rejected
AMOUNT_MIN = 1
AMOUNT_MAX = 5_000_000

# ── The system prompt sent to Llama 3 ────────────────────────────────────────
# This is the single most important thing to get right.
# It tells the LLM exactly what shape to reply in and what it must not do.

SYSTEM_PROMPT = """You are a backend parser for FinBud AI, a multilingual Pakistani banking chatbot.

The chatbot supports English, Urdu, and Roman Urdu (Urdu written in Latin script).

Your ONLY job is to parse user messages and return a JSON object.
Do NOT write any explanation. Do NOT include markdown. Return raw JSON only.

──────────────────────────────────────────────
JSON SCHEMA YOU MUST RETURN (always all keys present):
{
  "intent": "<one of the valid intents below>",
  "entities": {
    "amount": <integer rupees or null>,
    "recipient": "<string name or null>",
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
4. For recipient: extract ONLY the person's name, nothing else.
5. For bill_type: map all variants (bijli/bijlee/electricity → electricity, pani/paani → water, etc.)
6. For conversational_reply: ONLY populate this when intent is "general_chat".
   Write the reply in the SAME language the user used (English / Urdu / Roman Urdu).
7. If a field is not present in the user message, set it to null.
8. NEVER set intent to a payment/transfer action based on ambiguous input.
   When in doubt, prefer "unknown" over a financial intent.
"""


class LLMFallback:
    """
    Wraps the Groq/Llama-3 API call. Constructed once at app startup
    and then called via .classify() for every regex miss.
    """

    def __init__(self, api_key: str = None, model: str = "llama-3.3-70b-versatile"):
        """
        api_key : your Groq API key (falls back to GROQ_API_KEY env var)
        model   : Groq model ID — llama-3.3-70b-versatile is the best
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
        flow_state    : e.g. 'TRANSFER_AWAIT_RECIPIENT' — finer context
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

        # recipient
        raw_recipient = raw_entities.get('recipient')
        if raw_recipient and isinstance(raw_recipient, str):
            cleaned_recipient = raw_recipient.strip()
            # Must contain at least one letter and no digits (names aren't numbers)
            if re.search(r'[a-zA-Z\u0600-\u06FF]', cleaned_recipient) \
                    and not re.fullmatch(r'\d+', cleaned_recipient):
                entities['recipient'] = cleaned_recipient.title()

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
