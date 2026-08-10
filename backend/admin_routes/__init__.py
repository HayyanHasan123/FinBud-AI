# admin_routes/__init__.py
#
# Aggregates every admin blueprint that currently exists so app.py can
# register them all in one loop, the same way it already does for
# advisor_profile_bp, goals_bp, investing_guide_bp, etc.
#
# auth.py is imported FIRST and separately from the rest — chat_monitor.py
# and overview.py both do `from admin_routes.auth import require_admin_*`,
# so admin_routes.auth needs to already be a fully-loaded submodule before
# those two are imported below, or Python's circular-import resolution can
# get confused. Keep this ordering if you add more files that import from
# admin_routes.auth.
#
# activity.py, fraud.py, kyc.py, and rewards.py are still empty — they are
# intentionally NOT imported here yet. Once each defines its blueprint,
# add it to both blocks below.

from .auth import auth_bp
from .overview import overview_bp
from .chat_monitor import chat_monitor_bp
from .tickets import tickets_bp
from .transactions import transactions_bp
from .users import users_bp
from .fees import fees_bp
from .settings import settings_bp

from .fraud import fraud_bp
from .activity import activity_bp
from .rewards import rewards_bp
from .kyc import kyc_bp

ADMIN_BLUEPRINTS = [
    auth_bp,           # /api/admin               (login, logout, me, health, users/search)
    overview_bp,        # /api/admin/overview
    chat_monitor_bp,     # /api/admin/chat-monitor
    tickets_bp,           # /api/admin/tickets
    transactions_bp,       # /api/admin/transactions
    users_bp,                # /api/admin/users
    fees_bp,                  # /api/admin/fees
    settings_bp,               # /api/admin/settings
    fraud_bp,
    activity_bp, 
    rewards_bp,
    kyc_bp
]