# admin_tables.py
# ─────────────────────────────────────────────────────────────────────────────
# Single schema-setup module for everything the admin_routes/* files need
# that doesn't already exist in the database. Call init_admin_tables() once
# from app.py, right after the existing init_db() call.
#
#   from admin_tables import init_admin_tables
#   ...
#   init_db()
#   init_admin_tables()
# ─────────────────────────────────────────────────────────────────────────────

from features import get_pg_conn, release_pg_conn


def init_admin_tables():
    conn = get_pg_conn()
    try:
        c = conn.cursor()

        # ── admin_users (needed by auth.py, and referenced by fraud.py /
        #    kyc.py / handoff_queue reviewer columns) ────────────────────────
        c.execute('''
        CREATE TABLE IF NOT EXISTS admin_users(
          id             SERIAL PRIMARY KEY,
          name           VARCHAR(120) NOT NULL,
          email          VARCHAR(120) UNIQUE NOT NULL,
          password_hash  TEXT NOT NULL,
          role           VARCHAR(20) NOT NULL DEFAULT 'banker',
          status         VARCHAR(20) NOT NULL DEFAULT 'active',
          created_at     VARCHAR(64),
          last_login     VARCHAR(64)
        )''')

        # No public signup route exists anywhere on purpose. The first row
        # must be inserted manually, e.g.:
        #   INSERT INTO admin_users(name, email, password_hash, role, status, created_at)
        #   VALUES ('Hayyan Hasan', 'someone@example.com',
        #           generate_password_hash('choose-a-password'), 'admin', 'active', NOW()::text);

        # ── admin_login_log (from the original spec — was never created by
        #    this file or written to by auth.py's login() route; added here
        #    so login auditing actually works once auth.py is updated to
        #    insert into it) ────────────────────────────────────────────────
        c.execute('''
        CREATE TABLE IF NOT EXISTS admin_login_log(
          id           SERIAL PRIMARY KEY,
          admin_id     INTEGER REFERENCES admin_users(id),
          ip_address   VARCHAR(64),
          user_agent   TEXT,
          success      BOOLEAN,
          created_at   VARCHAR(64)
        )''')

        # ── system_config (settings.py thresholds sub-section) ─────────────
        c.execute('''
        CREATE TABLE IF NOT EXISTS system_config(
          id            SERIAL PRIMARY KEY,
          config_key    VARCHAR(60) UNIQUE NOT NULL,
          config_value  TEXT NOT NULL,
          updated_at    VARCHAR(64),
          updated_by    INTEGER REFERENCES admin_users(id)
        )''')

        seed_config = [
            ('large_transfer_threshold', '100000'),
            ('amount_spike_multiplier', '5'),
            ('rapid_fire_count', '5'),
            ('rapid_fire_window_minutes', '10'),
            ('odd_hours_start', '2'),
            ('odd_hours_end', '5'),
        ]
        for key, value in seed_config:
            c.execute("""
                INSERT INTO system_config(config_key, config_value)
                VALUES (%s, %s)
                ON CONFLICT (config_key) DO NOTHING
            """, (key, value))

        # ── dashboard_users.status (users.py freeze/unfreeze, per spec) ────
        c.execute("""
            ALTER TABLE dashboard_users ADD COLUMN IF NOT EXISTS
              status VARCHAR(20) DEFAULT 'active'
        """)

        # NOT PART OF THE ORIGINAL SPEC, BUT REQUIRED FOR CORRECTNESS:
        # fraud.py (already delivered, not modified here) reads/writes
        # dashboard_users.account_status (freeze_account / get_alert), which
        # is a DIFFERENT column name than the `status` column the spec asked
        # for on this table. Rather than silently letting fraud.py 500 on
        # every call, both columns are created and kept in sync-ish: `status`
        # for whatever users.py ends up using, `account_status` because
        # fraud.py already ships hard-coded against that exact name.
        c.execute("""
            ALTER TABLE dashboard_users ADD COLUMN IF NOT EXISTS
              account_status VARCHAR(20) DEFAULT 'active'
        """)

        # ── dashboard_transactions.anomaly_flagged (transactions.py) ───────
        c.execute("""
            ALTER TABLE dashboard_transactions ADD COLUMN IF NOT EXISTS
              anomaly_flagged BOOLEAN DEFAULT false
        """)

        # ── cards extra columns (users.py card list) ────────────────────────
        # NOTE: app.py's init_user_tables() already adds these three columns
        # to `cards` as TEXT. These statements are idempotent no-ops in that
        # case (IF NOT EXISTS), kept here only so this file is self-sufficient
        # if it ever runs against a database that skipped that step.
        c.execute("ALTER TABLE cards ADD COLUMN IF NOT EXISTS cardholder_name VARCHAR(120)")
        c.execute("ALTER TABLE cards ADD COLUMN IF NOT EXISTS expiry VARCHAR(10)")
        c.execute("ALTER TABLE cards ADD COLUMN IF NOT EXISTS nickname VARCHAR(60)")

        # ── transfer_fees (fees.py) ──────────────────────────────────────────
        c.execute('''
        CREATE TABLE IF NOT EXISTS transfer_fees(
          id                SERIAL PRIMARY KEY,
          transaction_id    INTEGER REFERENCES dashboard_transactions(id),
          account_number    VARCHAR(30) REFERENCES dashboard_users(account_number),
          transfer_amount   NUMERIC(15,2),
          fee_amount        NUMERIC(15,2),
          fee_percentage    NUMERIC(5,4),
          created_at        VARCHAR(64)
        )''')
        # FLAG (out of scope for these 5 files): this table stays empty
        # forever unless /api/transaction/create in app.py is also updated
        # to compute a fee and INSERT a row here on every transfer. Not
        # done here — raise separately with whoever owns that route.

        # ── handoff_queue extra columns (tickets.py) ────────────────────────
        c.execute("ALTER TABLE handoff_queue ADD COLUMN IF NOT EXISTS resolution_note TEXT")
        c.execute("ALTER TABLE handoff_queue ADD COLUMN IF NOT EXISTS cancel_reason TEXT")
        c.execute("""
            ALTER TABLE handoff_queue ADD COLUMN IF NOT EXISTS
              resolved_by INTEGER REFERENCES admin_users(id)
        """)
        c.execute("""
            ALTER TABLE handoff_queue ADD COLUMN IF NOT EXISTS
              cancelled_by INTEGER REFERENCES admin_users(id)
        """)
        c.execute("""
            ALTER TABLE handoff_queue ADD COLUMN IF NOT EXISTS
              assigned_to INTEGER REFERENCES admin_users(id)
        """)

        # ── chat_history extra columns (chat_monitor.py) ────────────────────
        c.execute("""
            ALTER TABLE chat_history ADD COLUMN IF NOT EXISTS
              sender VARCHAR(10) DEFAULT 'ai'
        """)
        c.execute("""
            ALTER TABLE chat_history ADD COLUMN IF NOT EXISTS
              engine VARCHAR(10)
        """)
        # `engine` is intentionally left NULL for now / not populated by any
        # route added here. Backfilling it is the hybrid-NLP team's work, not
        # this migration's.

        # NOT PART OF THE ORIGINAL SPEC, BUT NEEDED FOR activity.py (already
        # delivered) TO WORK: activity.py's get_chat() references a
        # chat_history.llm_used boolean column that exists nowhere in
        # features.py or app.py — app.py only ever put `llm_used` in the JSON
        # response payload, never persisted it as a column. Without this,
        # activity.py's CASE expression referencing llm_used will fail on
        # every call. Adding it here as a nullable column so the query
        # doesn't 500; it will simply be NULL on every existing row (and on
        # new rows too, until someone updates the INSERT INTO chat_history
        # calls in app.py to also set it — also out of scope here, flagging
        # only).
        c.execute("""
            ALTER TABLE chat_history ADD COLUMN IF NOT EXISTS
              llm_used BOOLEAN
        """)

        # ── kyc_submissions (needed by the already-delivered kyc.py) ────────
        # CONFIRMED MISSING from features.py / app.py — this table does not
        # exist anywhere else. kyc.py's routes would 500 on first use without
        # it, despite kyc.py itself being someone else's file.
        c.execute('''
        CREATE TABLE IF NOT EXISTS kyc_submissions(
          id              SERIAL PRIMARY KEY,
          account_number  VARCHAR(30) REFERENCES dashboard_users(account_number),
          cnic_number     VARCHAR(20) NOT NULL,
          selfie_url      TEXT,
          cnic_front_url  TEXT,
          status          VARCHAR(20) DEFAULT 'pending',
          flag_reason     VARCHAR(120),
          reviewed_by     INTEGER REFERENCES admin_users(id),
          submitted_at    VARCHAR(64),
          reviewed_at     VARCHAR(64)
        )''')

        # NOT PART OF THE ORIGINAL SPEC, BUT REQUIRED FOR CORRECTNESS:
        # fraud.py (already delivered) reads/writes fraud_alerts.anomaly_type,
        # .status, .transaction_id, .reviewed_by, and .resolution_note.
        # app.py's fraud_alerts table only has (id, account_number, message,
        # created_at) — none of those five columns exist. Same situation as
        # kyc_submissions above: fraud.py is someone else's file, but the
        # missing schema underneath it is this migration's responsibility to
        # flag and fill in, so it's added here rather than left to 500 in
        # production.
        c.execute("""
            ALTER TABLE fraud_alerts ADD COLUMN IF NOT EXISTS
              anomaly_type VARCHAR(60)
        """)
        c.execute("""
            ALTER TABLE fraud_alerts ADD COLUMN IF NOT EXISTS
              status VARCHAR(20) DEFAULT 'unreviewed'
        """)
        c.execute("""
            ALTER TABLE fraud_alerts ADD COLUMN IF NOT EXISTS
              transaction_id INTEGER REFERENCES dashboard_transactions(id)
        """)
        c.execute("""
            ALTER TABLE fraud_alerts ADD COLUMN IF NOT EXISTS
              reviewed_by INTEGER REFERENCES admin_users(id)
        """)
        c.execute("""
            ALTER TABLE fraud_alerts ADD COLUMN IF NOT EXISTS
              resolution_note TEXT
        """)

        conn.commit()
    finally:
        release_pg_conn(conn)