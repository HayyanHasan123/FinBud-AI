// <Modal open={open} onClose={...} title="Freeze account for Ahmed Khan?" danger
//        footer={<><button onClick={cancel}>Cancel</button><button onClick={confirm}>Confirm</button></>}>
//   <p>All cards will be locked...</p>
// </Modal>
export default function Modal({ open, onClose, title, children, footer, danger = false, width = 440 }) {
  if (!open) return null

  return (
    <div className="ac-modal-overlay" onClick={onClose}>
      <style>{`
        .ac-modal-overlay {
          position: fixed; inset: 0; background: rgba(15, 10, 25, 0.55);
          backdrop-filter: blur(3px); display: flex; align-items: center;
          justify-content: center; z-index: 500; padding: 20px;
        }
        .ac-modal-box {
          background: var(--color-card-bg); border-radius: var(--radius-lg);
          padding: 26px 28px; width: 100%; box-shadow: var(--shadow-modal);
          max-height: 88vh; overflow-y: auto; position: relative;
        }
        .ac-modal-close {
          position: absolute; top: 14px; right: 16px; background: none; border: none;
          font-size: 20px; line-height: 1; cursor: pointer; color: var(--color-text-muted);
        }
        .ac-modal-title {
          margin: 0 0 16px; font-size: 18px; font-weight: 700;
          color: ${danger ? 'var(--color-danger)' : 'var(--color-text-primary)'};
          padding-right: 20px;
        }
        .ac-modal-body { font-size: 13.5px; color: var(--color-text-secondary); line-height: 1.6; }
        .ac-modal-footer {
          display: flex; gap: 10px; margin-top: 22px; justify-content: flex-end;
        }
      `}</style>
      <div className="ac-modal-box" style={{ maxWidth: width }} onClick={e => e.stopPropagation()}>
        <button className="ac-modal-close" onClick={onClose}>×</button>
        {title && <h3 className="ac-modal-title">{title}</h3>}
        <div className="ac-modal-body">{children}</div>
        {footer && <div className="ac-modal-footer">{footer}</div>}
      </div>
    </div>
  )
}