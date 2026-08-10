// <StatCard label="Total Users" value="4,821" trend="+12 today" trendType="up" />
// trendType: 'up' | 'down' | 'neutral' (controls trend color) — pass 'up' when
// the trend is good news, 'down' when it's bad news; this is independent of
// whether the number itself went up or down (e.g. "-3 fraud alerts" is 'up').
export default function StatCard({ label, value, trend, trendType = 'neutral', icon, accent }) {
  return (
    <div className="stat-card">
      <style>{`
        .stat-card {
          background: var(--color-card-bg);
          border: 1px solid var(--color-border);
          border-radius: var(--radius-md);
          padding: 18px 20px;
          box-shadow: var(--shadow-card);
          display: flex;
          flex-direction: column;
          gap: 6px;
          min-width: 0;
        }
        .stat-card-top { display: flex; align-items: center; justify-content: space-between; }
        .stat-card-label {
          font-size: 12px; font-weight: 600; text-transform: uppercase;
          letter-spacing: 0.4px; color: var(--color-text-secondary);
        }
        .stat-card-icon {
          width: 30px; height: 30px; border-radius: 8px;
          display: flex; align-items: center; justify-content: center;
          background: ${accent ? `var(--color-${accent}-light)` : 'var(--color-primary-light)'};
          color: ${accent ? `var(--color-${accent})` : 'var(--color-primary)'};
          font-size: 13px; flex-shrink: 0;
        }
        .stat-card-value { font-size: 26px; font-weight: 700; color: var(--color-text-primary); line-height: 1.1; }
        .stat-card-trend { font-size: 12px; font-weight: 600; }
        .stat-card-trend.up { color: var(--color-success); }
        .stat-card-trend.down { color: var(--color-danger); }
        .stat-card-trend.neutral { color: var(--color-text-muted); }
      `}</style>
      <div className="stat-card-top">
        <span className="stat-card-label">{label}</span>
        {icon && <span className="stat-card-icon"><i className={`fas ${icon}`} /></span>}
      </div>
      <span className="stat-card-value">{value}</span>
      {trend && <span className={`stat-card-trend ${trendType}`}>{trend}</span>}
    </div>
  )
}