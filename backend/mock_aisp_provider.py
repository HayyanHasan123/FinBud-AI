# mock_aisp_provider.py
# ─────────────────────────────────────────────────────────────────────────────
# Mock AISP (Account Information Service Provider) — the read-only half of
# Open Banking. Pakistan has no live consumer Open Banking regime yet (SBP's
# framework is still in regulatory sandbox as of 2026), so a real bank can't
# be linked today. This module plays the part of "the bank's own consent +
# data-sharing portal" that a FinBud user is redirected to when linking an
# account, and hands back read-only account data once they approve.
#
# This is AISP ONLY. There is no payment/transfer/token-spending endpoint
# anywhere in this file, and there never should be — a real AISP integration
# could never move money either, so the mock doesn't pretend otherwise.
#
# Flow (mirrors a real OAuth2/Open Banking authorization-code exchange):
#   1. FinBud (app.py) sends the user here with a CSRF `state` + its own
#      `redirect_uri`.
#   2. GET  /mock-aisp/consent   → login page (demo_user / demo1234)
#   3. POST /mock-aisp/consent   → step=login:   verify credentials,
#                                                 show scope-by-scope consent screen
#                                  step=approve:  issue a short-lived,
#                                                 single-use authorization code,
#                                                 redirect back to FinBud
#                                  step=deny:     redirect back with an error
#   4. app.py calls mock_aisp_exchange_code(code, redirect_uri) in-process
#      (a plain Python function, not an HTTP route) to redeem the code for
#      the mocked account data.
# ─────────────────────────────────────────────────────────────────────────────

from flask import Blueprint, request, redirect
from datetime import datetime, timedelta
import html
import secrets
from urllib.parse import quote

mock_aisp_bp = Blueprint('mock_aisp', __name__, url_prefix='/mock-aisp')

# ── Demo credentials & seed account ─────────────────────────────────────────
DEMO_USERNAME    = 'demo_user'
DEMO_PASSWORD    = 'demo1234'
DEMO_BANK_NAME   = 'MockBank (Demo)'
DEMO_IBAN        = 'PK36MOCK0000001234567'
DEMO_HOLDER_NAME = 'DEMO USER'
DEMO_BALANCE     = 458230.50
DEMO_SCOPES      = 'balance,transactions,identity'

# amount: signed, negative = debit, positive = credit. days_ago is resolved
# to a real date at exchange time, so the transaction list always reads as
# "the last 30 days" no matter when the demo is run.
_DEMO_TRANSACTIONS_TEMPLATE = [
    {'description': 'Salary Credit — Horizon Systems Ltd', 'amount':  85000.00, 'days_ago': 2},
    {'description': 'K-Electric Bill Payment',              'amount':  -4820.00, 'days_ago': 5},
    {'description': 'Sui Southern Gas Bill',                'amount':  -1650.00, 'days_ago': 7},
    {'description': 'Imtiaz Super Market',                  'amount':  -6340.75, 'days_ago': 9},
    {'description': 'Meezan Bank Profit (Savings)',         'amount':   1120.30, 'days_ago': 13},
    {'description': 'Chai Wala Cafe',                       'amount':   -850.00, 'days_ago': 16},
    {'description': 'Jazz Mobile Load',                     'amount':  -1000.00, 'days_ago': 19},
    {'description': 'Al-Fatah Grocers',                     'amount':  -3275.50, 'days_ago': 25},
]


def _build_transactions():
    today = datetime.utcnow().date()
    return [
        {
            'description': t['description'],
            'amount': t['amount'],
            'date': (today - timedelta(days=t['days_ago'])).isoformat(),
        }
        for t in _DEMO_TRANSACTIONS_TEMPLATE
    ]


# ── In-memory single-use token stores ───────────────────────────────────────
# A student-project mock, not a production token service — in-process dicts
# are fine here (same pattern as the earlier mocked-bank work). Two separate
# stores because they guard two separate steps of the flow:
#   _pending_logins  bridges "password verified" -> "consent screen shown",
#                    so the approve step can't be reached without logging in.
#   _auth_codes      the actual OAuth-style authorization code, redeemed
#                    exactly once by mock_aisp_exchange_code().
_pending_logins = {}   # login_token -> {'expires': datetime}
_auth_codes     = {}   # code        -> {'redirect_uri': str, 'expires': datetime, 'used': bool}

LOGIN_TOKEN_TTL_SECONDS = 10 * 60
AUTH_CODE_TTL_SECONDS   = 2 * 60


def _issue_login_token():
    _cleanup(_pending_logins)
    token = secrets.token_urlsafe(24)
    _pending_logins[token] = {'expires': datetime.utcnow() + timedelta(seconds=LOGIN_TOKEN_TTL_SECONDS)}
    return token


def _consume_login_token(token):
    entry = _pending_logins.pop(token, None)
    if not entry:
        return False
    return datetime.utcnow() <= entry['expires']


def _issue_auth_code(redirect_uri):
    _cleanup(_auth_codes)
    code = secrets.token_urlsafe(32)
    _auth_codes[code] = {
        'redirect_uri': redirect_uri,
        'expires': datetime.utcnow() + timedelta(seconds=AUTH_CODE_TTL_SECONDS),
        'used': False,
    }
    return code


def _cleanup(store):
    now = datetime.utcnow()
    dead = [k for k, v in store.items() if v['expires'] < now]
    for k in dead:
        store.pop(k, None)


def mock_aisp_exchange_code(code, redirect_uri):
    """
    Redeems a single-use authorization code for the (mocked) account data it
    grants access to. Called directly from app.py, in-process — this is a
    plain function, not an HTTP route, same as the earlier mock-bank work.

    Returns None if the code is missing, expired, already used, or was
    issued for a different redirect_uri (basic authorization-code-flow
    hygiene — mirrors real OAuth2 / Open Banking token exchange).

    On success:
    {
      'bank_name': 'MockBank (Demo)', 'iban': ..., 'holder_name': ...,
      'balance': 458230.50, 'transactions': [{'description','amount','date'}, ...],
      'scopes': 'balance,transactions,identity',
    }
    """
    entry = _auth_codes.get(code)
    if not entry:
        return None
    if entry['used']:
        return None
    if entry['redirect_uri'] != redirect_uri:
        return None
    if datetime.utcnow() > entry['expires']:
        return None

    entry['used'] = True  # single-use, even on repeated calls with the same code

    return {
        'bank_name': DEMO_BANK_NAME,
        'iban': DEMO_IBAN,
        'holder_name': DEMO_HOLDER_NAME,
        'balance': DEMO_BALANCE,
        'transactions': _build_transactions(),
        'scopes': DEMO_SCOPES,
    }


# ── HTML rendering ───────────────────────────────────────────────────────────
# Deliberately styled as a distinct, separate institution (dark navy, bank-
# vault visual language) so it reads as "you've left FinBud and are now on
# your bank's own site" — that handoff is the whole point of AISP: FinBud
# never sees the password, the bank's own portal collects it.

_PAGE_SHELL = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>
<style>
  * {{ box-sizing: border-box; }}
  body {{
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    background: radial-gradient(circle at top, #16213e 0%, #0b0f1e 65%);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    padding: 24px;
  }}
  .panel {{
    width: 100%; max-width: 420px; background: #101a33; border: 1px solid #22315a;
    border-radius: 16px; padding: 32px 28px; color: #e7ecff; box-shadow: 0 20px 60px rgba(0,0,0,0.45);
  }}
  .brand {{ display: flex; align-items: center; gap: 10px; margin-bottom: 4px; }}
  .brand-mark {{
    width: 34px; height: 34px; border-radius: 9px; background: linear-gradient(135deg, #3b5bff, #6dd5ff);
    display: flex; align-items: center; justify-content: center; font-size: 18px;
  }}
  .brand-name {{ font-size: 17px; font-weight: 700; letter-spacing: 0.2px; }}
  .away-banner {{
    margin: 16px 0 22px; font-size: 12px; color: #9db3ff; background: #17224a;
    border: 1px solid #2a3a72; border-radius: 8px; padding: 8px 12px; line-height: 1.4;
  }}
  h1 {{ font-size: 19px; margin: 0 0 6px; }}
  .sub {{ font-size: 13px; color: #9aa4c7; margin: 0 0 22px; line-height: 1.5; }}
  label {{ display: block; font-size: 12px; color: #aeb7d6; margin: 14px 0 6px; }}
  input[type=text], input[type=password] {{
    width: 100%; padding: 11px 12px; border-radius: 9px; border: 1px solid #2c3a66;
    background: #0c1428; color: #f1f4ff; font-size: 14px;
  }}
  input:focus {{ outline: none; border-color: #5b7cff; }}
  .btn {{
    width: 100%; padding: 12px; border-radius: 9px; border: none; font-size: 14px; font-weight: 600;
    cursor: pointer; margin-top: 18px;
  }}
  .btn-primary {{ background: linear-gradient(135deg, #3b5bff, #5a8dff); color: #fff; }}
  .btn-secondary {{ background: transparent; color: #aeb7d6; border: 1px solid #2c3a66; margin-top: 10px; }}
  .error {{ background: #3a1630; border: 1px solid #6b2350; color: #ff9ec7; font-size: 13px; border-radius: 8px; padding: 9px 12px; margin-top: 14px; }}
  .hint {{ font-size: 11.5px; color: #6f7aa3; margin-top: 18px; line-height: 1.5; }}
  .hint code {{ background: #0c1428; padding: 1px 5px; border-radius: 4px; color: #cdd6ff; }}
  .scope-list {{ margin: 18px 0; padding: 0; list-style: none; }}
  .scope-list li {{
    display: flex; gap: 10px; align-items: flex-start; font-size: 13.5px; color: #dbe1ff;
    padding: 10px 0; border-bottom: 1px solid #1c294f;
  }}
  .scope-list li:last-child {{ border-bottom: none; }}
  .scope-check {{
    flex: none; width: 18px; height: 18px; border-radius: 5px; background: #223163;
    border: 1px solid #3b5bff; color: #7fe0a4; display: flex; align-items: center; justify-content: center;
    font-size: 12px; margin-top: 1px;
  }}
  .account-chip {{
    background: #0c1428; border: 1px solid #22315a; border-radius: 10px; padding: 12px 14px;
    font-size: 13px; color: #cdd6ff; margin-top: 16px;
  }}
  .account-chip strong {{ color: #fff; }}
  .footer-note {{ font-size: 11px; color: #5c6791; margin-top: 20px; line-height: 1.5; text-align: center; }}
</style>
</head>
<body>
  <div class="panel">
    <div class="brand">
      <div class="brand-mark">🏦</div>
      <div class="brand-name">MockBank</div>
    </div>
    <div class="away-banner">🔒 You've left FinBud. This page belongs to MockBank's own (simulated) Open Banking portal — not FinBud.</div>
    {body}
    <div class="footer-note">Demo institution for illustration only. No real bank, no real money.</div>
  </div>
</body>
</html>"""


def _page(title, body):
    return _PAGE_SHELL.format(title=html.escape(title), body=body)


def _hidden(name, value):
    return f'<input type="hidden" name="{html.escape(name)}" value="{html.escape(value)}">'


def _login_page(state, redirect_uri, error=None):
    error_html = f'<div class="error">{html.escape(error)}</div>' if error else ''
    body = f"""
      <h1>Sign in to MockBank</h1>
      <p class="sub">FinBud wants to connect to your MockBank account. Sign in below — MockBank never shares your password with FinBud.</p>
      <form method="POST" action="/mock-aisp/consent">
        {_hidden('step', 'login')}
        {_hidden('state', state)}
        {_hidden('redirect_uri', redirect_uri)}
        <label for="username">Username</label>
        <input type="text" id="username" name="username" autocomplete="username" required>
        <label for="password">Password</label>
        <input type="password" id="password" name="password" autocomplete="current-password" required>
        {error_html}
        <button type="submit" class="btn btn-primary">Sign In</button>
      </form>
      <p class="hint">Demo login — username <code>demo_user</code>, password <code>demo1234</code>.</p>
    """
    return _page('Sign in — MockBank', body)


def _consent_page(state, redirect_uri, login_token):
    masked_iban = f"{DEMO_IBAN[:4]} **** **** **** {DEMO_IBAN[-4:]}"
    body = f"""
      <h1>FinBud wants to access your account</h1>
      <p class="sub">Review what you're sharing. This access is read-only and you can revoke it in FinBud at any time.</p>
      <div class="account-chip"><strong>{html.escape(DEMO_HOLDER_NAME)}</strong><br>{html.escape(masked_iban)}</div>
      <ul class="scope-list">
        <li><span class="scope-check">✓</span> View your account balance</li>
        <li><span class="scope-check">✓</span> View your last 30 days of transactions</li>
        <li><span class="scope-check">✓</span> View your account holder name</li>
      </ul>
      <form method="POST" action="/mock-aisp/consent">
        {_hidden('step', 'approve')}
        {_hidden('state', state)}
        {_hidden('redirect_uri', redirect_uri)}
        {_hidden('login_token', login_token)}
        <button type="submit" class="btn btn-primary">Allow read-only access</button>
      </form>
      <form method="POST" action="/mock-aisp/consent">
        {_hidden('step', 'deny')}
        {_hidden('state', state)}
        {_hidden('redirect_uri', redirect_uri)}
        <button type="submit" class="btn btn-secondary">Deny</button>
      </form>
      <p class="hint">MockBank never gives FinBud the ability to move money out of this account — balance and transaction visibility only.</p>
    """
    return _page('Review access — MockBank', body)


def _error_page():
    return _page(
        'MockBank — Error',
        '<h1>Linking request not recognized</h1>'
        '<p class="sub">This link is missing required information, or has expired. '
        'Please return to FinBud and try connecting your account again.</p>'
    ), 400


# ── Routes ────────────────────────────────────────────────────────────────

@mock_aisp_bp.route('/consent', methods=['GET'])
def consent_login_page():
    state = request.args.get('state', '')
    redirect_uri = request.args.get('redirect_uri', '')
    if not state or not redirect_uri:
        return _error_page()
    return _login_page(state, redirect_uri)


@mock_aisp_bp.route('/consent', methods=['POST'])
def consent_submit():
    step = request.form.get('step', '')
    state = request.form.get('state', '')
    redirect_uri = request.form.get('redirect_uri', '')

    if not state or not redirect_uri:
        return _error_page()

    if step == 'login':
        username = request.form.get('username', '').strip()
        password = request.form.get('password', '')
        if username != DEMO_USERNAME or password != DEMO_PASSWORD:
            return _login_page(state, redirect_uri, error='Incorrect username or password.')
        login_token = _issue_login_token()
        return _consent_page(state, redirect_uri, login_token)

    if step == 'deny':
        return redirect(f"{redirect_uri}?error=access_denied&state={quote(state)}")

    if step == 'approve':
        login_token = request.form.get('login_token', '')
        if not _consume_login_token(login_token):
            return _login_page(state, redirect_uri, error='Your session expired — please sign in again.')
        code = _issue_auth_code(redirect_uri)
        return redirect(f"{redirect_uri}?code={quote(code)}&state={quote(state)}")

    return _error_page()