"""
advisor_chat.py  —  FinBud AI: Financial Advisor chat bubble
==============================================================

Handles chat messages sent with {"context": "financial_advisor"} from the
Grow My Money chat bubble (frontend: components/advisor/AdvisorChatBubble.jsx).

Deliberately kept separate from nlp_module.py's BankAIConversation state
machine — this is a plain one-shot "answer using the user's real numbers"
call, not a multi-turn banking flow, so it doesn't need slots/intents/
confirmation steps. It reuses the same Groq client + model already wired
up in llm_fallback.py so no new API key or provider is introduced.

If Groq is unavailable or the call fails for any reason, this falls back
to a safe, static message instead of raising — the chat bubble must never
500 just because the LLM call had a hiccup.
"""

import os
import logging

try:
    from groq import Groq
    GROQ_AVAILABLE = True
except ImportError:
    GROQ_AVAILABLE = False

logger = logging.getLogger(__name__)

MODEL = "openai/gpt-oss-120b"

SYSTEM_PROMPT = """You are FinBud AI's financial advisor assistant, speaking inside the \
"Grow My Money" section of the FinBud banking app.

Rules:
- Only discuss the user's own income, expenses, safe-to-spend, saving goals, and \
investing profile — using the data provided below. Do not discuss unrelated banking \
features (transfers, cards, bill payments) — politely redirect the user to the main \
chat for those.
- Never recommend a specific stock, fund, or product. You may describe general \
categories (e.g. "safe, slow-growth" vs "some risk, faster growth").
- Keep answers short (1-3 sentences), plain-language, and free of jargon.
- Match tone to the user's experience_level if provided: "never" -> extra simple, \
with a real-world analogy; "a_little" -> simple but a bit more direct; \
"comfortable" -> can be more direct/technical.
- Speak like a friendly, approachable financial guide — not a form or a script — \
while staying concise (1-3 sentences).
- This app serves Pakistan ONLY. Never use the ₹ (Indian Rupee) symbol or refer to \
India/Indian Rupees under any circumstance. Always denote currency as "Rs" or "PKR" \
(e.g. "Rs 5,000" or "PKR 5,000"). Do not discuss any other country's currency or \
financial systems.
- FinBud currently supports ONLY English, Urdu (script), and Roman Urdu (Urdu \
written in Latin letters). If the user asks for a reply in any other language \
(Sindhi, Punjabi, Pashto, Hindi, Arabic, etc.), politely decline and explain that \
only English/Urdu/Roman Urdu are supported right now, then answer their original \
question in English or in whatever of the 3 supported languages they were already \
using — do NOT comply with the unsupported-language request.
"""

_client = None


def _get_client():
    global _client
    if not GROQ_AVAILABLE:
        return None
    if _client is None:
        api_key = os.environ.get("GROQ_API_KEY")
        if not api_key:
            return None
        _client = Groq(api_key=api_key)
    return _client


def handle_advisor_chat(user_message: str, user_context: dict) -> str:
    """
    user_message : the raw text the user typed into the advisor chat bubble
    user_context : dict of the user's real numbers, e.g.
        {
          "income": 50000, "expenses": 30000, "net": 20000, "safe_to_spend": 15000,
          "goals": [{"goal_name": "Car", "target_amount": 500000, "saved_amount": 40000}],
          "experience_level": "a_little", "risk_preference": "balanced"
        }
    Returns a plain-text reply. Never raises.
    """
    client = _get_client()
    if client is None:
        return ("I can't reach the AI service right now, but here's what I can tell "
                "you from your numbers: your safe-to-spend and goal progress are "
                "shown above. Please try asking again in a moment.")

    try:
        user_prompt = (
            f"USER'S FINANCIAL DATA:\n{user_context}\n\n"
            f"USER'S QUESTION:\n{user_message}"
        )
        response = client.chat.completions.create(
            model=MODEL,
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": user_prompt},
            ],
            temperature=0.4,
            max_tokens=300,
        )
        return response.choices[0].message.content.strip()
    except Exception as exc:
        logger.error("advisor_chat Groq call failed: %s", exc)
        return ("Sorry, I couldn't work that out just now — please try asking again "
                "in a moment.")


GUIDE_SYSTEM_PROMPT = """You are FinBud AI's investing education guide, inside the \
"Grow My Money" section of a Pakistani banking app.

The user has picked one investment type they want to understand. Write a COMPLETE, \
practical, step-by-step guide for a beginner in Pakistan on how they could go about \
investing in it — entirely outside this app (FinBud does not execute investments).

Structure your answer with these sections, using short paragraphs or bullet points:
1. What it is (1-2 sentences, plain language)
2. Who it's generally suited for (risk/time-horizon, in plain language)
3. How someone actually gets started — concrete steps (e.g. which type of account to \
open, which regulated institutions/platforms are typically used in Pakistan — e.g. \
PSX brokers for stocks, SECP-licensed AMCs for mutual funds, NSS/Pakistan Investment \
Bonds for government schemes, gold via banks/registered dealers), and roughly what \
documents/minimum amounts are typically involved.
4. Typical costs/fees to expect (brokerage, management fees, etc. — general ranges, \
not exact numbers you're not sure of).
5. Key risks specific to this investment type.
6. One tip for a beginner.

Special rule for crypto: Pakistan's regulatory stance on cryptocurrency has shifted \
over time and is not fully settled — clearly say the user should check the current \
legal/regulatory status themselves (e.g. via SBP/SECP guidance) before proceeding, \
and emphasize that crypto is high-volatility and not suitable for money the user \
can't afford to lose.

Rules:
- Never name a specific company, fund, stock, or platform to buy/use — describe \
categories of regulated institutions instead (e.g. "a PSX-registered brokerage", \
not a named broker).
- Do not fabricate specific current fee percentages, tax rates, or thresholds; use \
"typically", "generally", "around" framing instead of precise numbers you can't verify.
- Plain language, minimal jargon, but this can be longer/more thorough than a normal \
chat reply since it's meant to be read as a guide (roughly 250-400 words).
- This app serves Pakistan ONLY. Never use the ₹ (Indian Rupee) symbol or refer to \
India/Indian Rupees under any circumstance. Always denote currency as "Rs" or "PKR" \
(e.g. "Rs 5,000" or "PKR 5,000"). Do not discuss any other country's currency or \
financial systems.
- FinBud currently supports ONLY English, Urdu (script), and Roman Urdu (Urdu \
written in Latin letters). If the user asks for this guide in any other language \
(Sindhi, Punjabi, Pashto, Hindi, Arabic, etc.), politely decline and explain that \
only English/Urdu/Roman Urdu are supported right now, then answer in English or in \
whatever of the 3 supported languages they were already using.
- End with: "This is educational information, not formal financial advice."
"""

INVESTMENT_TYPES = {
    'stocks': 'Buying shares of publicly listed companies (stock market investing)',
    'mutual_funds': 'Mutual funds / unit trusts (pooled, professionally managed funds)',
    'government_bonds': 'Government savings schemes and bonds (e.g. National Savings, government bonds/sukuk)',
    'gold': 'Investing in gold',
    'fixed_deposits': 'Bank fixed/term deposits and profit certificates',
    'crypto': 'Cryptocurrency (e.g. Bitcoin, Ethereum)',
}


def generate_investment_guide(investment_type: str, user_context: dict) -> str:
    """
    investment_type : one of the keys in INVESTMENT_TYPES (validated by the caller/route)
    user_context    : same shape as handle_advisor_chat's user_context (experience_level,
                       risk_preference, income/expenses if available)
    Returns a full guide as plain text. Never raises — falls back to a short static
    message if Groq is unavailable.
    """
    label = INVESTMENT_TYPES.get(investment_type, investment_type)
    client = _get_client()
    if client is None:
        return (f"A full guide on {label} isn't available right now — the guide "
                f"service is temporarily unreachable. Please try again shortly.")

    try:
        user_prompt = (
            f"Investment type: {label}\n"
            f"User's experience level: {user_context.get('experience_level', 'unknown')}\n"
            f"User's risk preference: {user_context.get('risk_preference', 'unknown')}\n\n"
            f"Write the complete guide now."
        )
        response = client.chat.completions.create(
            model=MODEL,
            messages=[
                {"role": "system", "content": GUIDE_SYSTEM_PROMPT},
                {"role": "user", "content": user_prompt},
            ],
            temperature=0.4,
            max_tokens=900,
        )
        return response.choices[0].message.content.strip()
    except Exception as exc:
        logger.error("generate_investment_guide Groq call failed: %s", exc)
        return "Sorry, I couldn't put that guide together just now — please try again in a moment."
