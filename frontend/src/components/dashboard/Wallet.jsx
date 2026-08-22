import InfoTip from './InfoTip.jsx'

// Wallet panel — net worth summary, linked bank accounts, and cards.
// Rendered by Dashboard.jsx (both website and mobile shells) when
// activeView === 'wallet'. Data (wallet, userData) and shared helpers
// (t, speak, setModal) are passed down as props so language switching
// and modal-opening (e.g. "+ Link Account", "+ Add Card") keep working
// exactly as before.
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
          {wallet.linkedBanksAvailable && wallet.linkedBanks.length > 0 ? (
            wallet.linkedBanks.map((acc, i) => (
              <div key={i} className="wallet-row">
                <div>
                  <strong>{acc.bank}</strong>
                  <div style={{ fontSize: 12, color: isMobile ? 'var(--text-dark)' : '#777' }}>{acc.masked_iban || acc.iban}</div>
                </div>
                <span className="wallet-status-pill">{acc.status || 'Linked'}</span>
              </div>
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