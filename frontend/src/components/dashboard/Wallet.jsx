import { useState } from 'react'
import InfoTip from './InfoTip.jsx'

// One linked (AISP-connected) bank account: bank + masked IBAN, real balance,
// a collapsible recent-transactions list, and a Revoke Access control. The
// revoke button never calls the API itself — it only opens Dashboard.jsx's
// 'confirmRevoke' modal, which owns the actual /api/aisp/revoke call. Once
// that completes and wallet.loaded flips back to true via the normal reload,
// this row simply disappears from the parent's list — no local removal logic
// needed here.
function LinkedAccountRow({ acc, isMobile, setModal }) {
  const [expanded, setExpanded] = useState(false)
  const txns = acc.transactions || []

  return (
    <div className="linked-account-block">
      <div className="wallet-row" style={{ borderBottom: 'none', paddingBottom: 0 }}>
        <div>
          <strong>{acc.bank}</strong>
          <div style={{ fontSize: 12, color: isMobile ? 'var(--text-dark)' : '#777' }}>{acc.masked_iban || acc.iban}</div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <strong className="linked-account-balance income-text">
            PKR {(acc.balance || 0).toLocaleString('en-PK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </strong>
          <span className="wallet-status-pill">{acc.status === 'active' ? 'Linked' : (acc.status || 'Linked')}</span>
        </div>
      </div>

      <div className="linked-account-actions">
        <button type="button" className="linked-account-toggle" onClick={() => setExpanded(e => !e)}>
          {expanded ? 'Hide transactions ▲' : `Show transactions (${txns.length}) ▼`}
        </button>
        <button
          type="button"
          className="linked-account-revoke"
          onClick={() => setModal({ type: 'confirmRevoke', consentId: acc.id, bankName: acc.bank })}
        >
          Revoke Access
        </button>
      </div>

      {expanded && (
        txns.length > 0 ? (
          <div className="linked-account-txns">
            {txns.map((tx, i) => (
              <div key={i} className="linked-account-txn-row">
                <div>
                  <div style={{ fontWeight: 600 }}>{tx.description}</div>
                  <div style={{ fontSize: 11, color: '#999' }}>{tx.date}</div>
                </div>
                <span className={tx.amount < 0 ? 'expense-text' : 'income-text'} style={{ fontWeight: 700, whiteSpace: 'nowrap' }}>
                  {tx.amount < 0 ? '-' : '+'}PKR {Math.abs(tx.amount).toLocaleString('en-PK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <p className="advisor-empty" style={{ margin: '4px 0' }}>No recent transactions.</p>
        )
      )}
    </div>
  )
}

// Wallet panel — net worth summary, linked bank accounts, and cards.
// Rendered by Dashboard.jsx (both website and mobile shells) when
// activeView === 'wallet'. Data (wallet, userData) and shared helpers
// (t, speak, setModal) are passed down as props so language switching
// and modal-opening (e.g. "+ Link Account", "+ Add Card") keep working
// exactly as before.
//
// wallet.linkedBanks now comes from /api/wallet/linked-accounts, which only
// ever returns AISP consents that are status='active' AND non-expired —
// revoked/expired accounts are excluded server-side, so summing everything
// in this array automatically mirrors the backend's active-consent rule;
// there's no separate "is this one active?" check needed on the frontend.
export default function WalletView({ t, wallet, userData, isMobile, speak, setModal }) {
  const linkedBalance = wallet.linkedBanks.reduce((s, a) => s + (a.balance || 0), 0)
  const netWorth = (userData.balance || 0) + linkedBalance + (wallet.otherAssets || 0)

  return (
    <div className="advisor-wrap">
      <div className="advisor-header">
        <div>
          <h2 className="advisor-title">{t('wallet_title')}</h2>
          <p className="advisor-subtitle">{t('wallet_subtitle')}</p>
        </div>
      </div>

      <div className="advisor-grid">
        <div className="card advisor-summary-card">
          <div className="card-header-row">
            <h3 style={{ marginTop: 0, marginBottom: 0 }}>{t('wallet_net_worth')}</h3>
            <button type="button" className="read-aloud-btn" aria-label="Read net worth aloud"
              onClick={() => speak(`Your total net worth is PKR ${netWorth.toLocaleString('en-PK')}. Your FinBud balance is PKR ${(userData.balance || 0).toLocaleString('en-PK')}.`)}>
              {t('read_aloud')}
            </button>
          </div>
          <div className="advisor-summary-row">
            <div className="advisor-stat">
              <span className="advisor-stat-label">{t('wallet_finbud_balance')}</span>
              <strong className="advisor-stat-value income-text">PKR {(userData.balance || 0).toLocaleString('en-PK')}</strong>
            </div>
            <div className="advisor-stat">
              <span className="advisor-stat-label">{t('wallet_linked_accounts')}</span>
              <strong className="advisor-stat-value">{wallet.linkedBanks.length > 0 ? `PKR ${linkedBalance.toLocaleString('en-PK')}` : '—'}</strong>
            </div>
            <div className="advisor-stat">
              <span className="advisor-stat-label">{t('wallet_other_assets')}</span>
              <strong className="advisor-stat-value">PKR {(wallet.otherAssets || 0).toLocaleString('en-PK')}</strong>
              <button type="button" className="edit-assets-link" onClick={() => setModal({ type: 'editAssets' })}>{t('wallet_edit')}</button>
            </div>
            <div className="advisor-stat">
              <span className="advisor-stat-label">{t('wallet_total_net_worth')} <InfoTip text="This adds up your FinBud balance, any linked bank accounts, and other assets you've told us about — a rough picture of everything you own through FinBud." /></span>
              <strong className="advisor-stat-value" style={{ color: 'var(--primary-purple)' }}>PKR {netWorth.toLocaleString('en-PK')}</strong>
            </div>
          </div>
          {wallet.linkedBanks.length === 0 && (
            <p className="advisor-footnote">{t('wallet_link_note')}</p>
          )}
        </div>

        <div className="card">
          <div className="wallet-card-header">
            <h3 style={{ margin: 0 }}>{t('wallet_linked_bank_accounts')}</h3>
            <button className="topup-btn" onClick={() => setModal({ type: 'linkBank' })}>{t('wallet_link_account')}</button>
          </div>
          <div className="open-banking-banner">
            🔒 <strong>Open Banking — Preview.</strong> This demonstrates the read-only (AISP) side of
            Open Banking with mocked bank data — view-only balance and transaction access, revocable
            anytime, with no involvement from a real bank. Initiating payments from a linked account
            (PISP) is a separate, not-yet-built capability — FinBud can never move money out of a
            linked account through this flow.
          </div>
          {wallet.linkedBanksAvailable && wallet.linkedBanks.length > 0 ? (
            wallet.linkedBanks.map((acc) => (
              <LinkedAccountRow key={acc.id} acc={acc} isMobile={isMobile} setModal={setModal} />
            ))
          ) : (
            <p className="advisor-empty">{t('wallet_no_banks')}</p>
          )}
        </div>

        <div className="card">
          <div className="wallet-card-header">
            <h3 style={{ margin: 0 }}>{t('wallet_my_cards')}</h3>
            <button className="topup-btn" onClick={() => setModal({ type: 'addCard' })}>{t('wallet_add_card')}</button>
          </div>
          {wallet.cards.length > 0 ? (
            wallet.cards.map(c => (
              <div key={c.card_id} className="wallet-row">
                <div>
                  <strong>{c.card_number_masked}</strong>
                </div>
                <span className={`wallet-status-pill ${c.status === 'locked' ? 'locked' : ''}`}>{c.status}</span>
              </div>
            ))
          ) : (
            <p className="advisor-empty">{t('wallet_no_cards')}</p>
          )}
        </div>
      </div>
    </div>
  )
}