// <EmptyState icon="fa-shield-halved" title="No fraud alerts" message="All clear — nothing needs review right now." />
export default function EmptyState({ icon = 'fa-inbox', title = 'Nothing here yet', message, action }) {
  return (
    <div className="ac-empty">
      <style>{`
        .ac-empty {
          display: flex; flex-direction: column; align-items: center; text-align: center;
          padding: 48px 24px; color: var(--color-text-secondary);
        }
        .ac-empty-icon {
          width: 48px; height: 48px; border-radius: 50%;
          background: var(--color-primary-light); color: var(--color-primary);
          display: flex; align-items: center; justify-content: center;
          font-size: 18px; margin-bottom: 14px;
        }
        .ac-empty-title { font-size: 14.5px; font-weight: 700; color: var(--color-text-primary); margin: 0 0 4px; }
        .ac-empty-message { font-size: 13px; margin: 0; max-width: 340px; line-height: 1.5; }
        .ac-empty-action { margin-top: 16px; }
      `}</style>
      <div className="ac-empty-icon"><i className={`fas ${icon}`} /></div>
      <p className="ac-empty-title">{title}</p>
      {message && <p className="ac-empty-message">{message}</p>}
      {action && <div className="ac-empty-action">{action}</div>}
    </div>
  )
}