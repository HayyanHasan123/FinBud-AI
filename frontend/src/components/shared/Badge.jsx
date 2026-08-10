// <Badge label="Resolved" color="success" />
// <Badge label="large_transfer" color="var(--color-anomaly-large-transfer)" />
// `color` accepts either a token name (success|danger|warning|info|primary)
// or a raw CSS color/var() — the anomaly-type badges in FraudAlertList need
// their own 7-color set (see admin-variables.css) so raw values are allowed.
const TOKEN_COLORS = {
  success: 'var(--color-success)',
  danger: 'var(--color-danger)',
  warning: 'var(--color-warning)',
  info: 'var(--color-info)',
  primary: 'var(--color-primary)',
  muted: 'var(--color-text-muted)'
}

const TOKEN_BG = {
  success: 'var(--color-success-light)',
  danger: 'var(--color-danger-light)',
  warning: 'var(--color-warning-light)',
  info: 'var(--color-info-light)',
  primary: 'var(--color-primary-light)',
  muted: '#f1f0f5'
}

export default function Badge({ label, color = 'muted' }) {
  const isToken = Object.prototype.hasOwnProperty.call(TOKEN_COLORS, color)
  const fg = isToken ? TOKEN_COLORS[color] : color
  const bg = isToken ? TOKEN_BG[color] : `color-mix(in srgb, ${color} 14%, white)`

  return (
    <span
      className="ac-badge"
      style={{ color: fg, background: bg }}
    >
      <style>{`
        .ac-badge {
          display: inline-block;
          font-size: 11px;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 0.3px;
          padding: 3px 10px;
          border-radius: 20px;
          white-space: nowrap;
        }
      `}</style>
      {label}
    </span>
  )
}