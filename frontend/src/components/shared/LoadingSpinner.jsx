// <LoadingSpinner /> or <LoadingSpinner label="Loading fraud alerts..." size="sm" />
export default function LoadingSpinner({ label = 'Loading...', size = 'md' }) {
  const dim = size === 'sm' ? 16 : size === 'lg' ? 32 : 22
  return (
    <div className="ac-spinner-wrap">
      <style>{`
        .ac-spinner-wrap {
          display: flex; align-items: center; justify-content: center;
          gap: 10px; padding: ${size === 'sm' ? '8px' : '40px 0'};
          color: var(--color-text-secondary); font-size: 13px;
        }
        .ac-spinner {
          width: ${dim}px; height: ${dim}px;
          border: 2.5px solid var(--color-primary-light);
          border-top-color: var(--color-primary);
          border-radius: 50%;
          animation: ac-spin 0.7s linear infinite;
        }
        @keyframes ac-spin { to { transform: rotate(360deg); } }
      `}</style>
      <span className="ac-spinner" />
      {label && <span>{label}</span>}
    </div>
  )
}