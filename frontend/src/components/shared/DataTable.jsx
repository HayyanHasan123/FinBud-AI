import LoadingSpinner from './LoadingSpinner'
import EmptyState from './EmptyState'

// <DataTable
//   columns={[
//     { key: 'name', label: 'User' },
//     { key: 'amount', label: 'Amount', align: 'right', render: (row) => formatPKR(row.amount) },
//     { key: 'status', label: 'Status', render: (row) => <Badge label={row.status} color="success" /> }
//   ]}
//   rows={rows}
//   loading={loading}
//   page={page} totalPages={totalPages} onPageChange={setPage}
//   sortKey={sortKey} sortDir={sortDir} onSort={handleSort}
//   onRowClick={(row) => openDetail(row)}
//   emptyTitle="No transactions" emptyMessage="Nothing matches these filters yet."
// />
// Column config: { key, label, align?, sortable?, render?(row) }
// Pagination is 20/page per the shared design rules — pass page/totalPages/
// onPageChange from whatever the backend returns ({ total, page, pages }).
export default function DataTable({
  columns,
  rows = [],
  loading = false,
  page = 1,
  totalPages = 1,
  onPageChange,
  sortKey,
  sortDir = 'asc',
  onSort,
  onRowClick,
  emptyIcon = 'fa-table',
  emptyTitle = 'No results',
  emptyMessage = 'Nothing matches the current filters.'
}) {
  return (
    <div className="ac-table-wrap">
      <style>{`
        .ac-table-wrap {
          background: var(--color-card-bg); border: 1px solid var(--color-border);
          border-radius: var(--radius-md); overflow: hidden; box-shadow: var(--shadow-card);
        }
        .ac-table { width: 100%; border-collapse: collapse; }
        .ac-table th {
          text-align: left; font-size: 11px; font-weight: 700; text-transform: uppercase;
          letter-spacing: 0.4px; color: var(--color-text-secondary); background: var(--color-content-bg);
          padding: 12px 16px; border-bottom: 1px solid var(--color-border); white-space: nowrap;
        }
        .ac-table th.sortable { cursor: pointer; user-select: none; }
        .ac-table th.sortable:hover { color: var(--color-primary); }
        .ac-table th.align-right, .ac-table td.align-right { text-align: right; }
        .ac-table td {
          padding: 13px 16px; font-size: 13px; color: var(--color-text-primary);
          border-bottom: 1px solid var(--color-border); vertical-align: middle;
        }
        .ac-table tr:last-child td { border-bottom: none; }
        .ac-table tbody tr.clickable { cursor: pointer; transition: background var(--transition-fast); }
        .ac-table tbody tr.clickable:hover { background: var(--color-content-bg); }
        .ac-sort-icon { margin-left: 5px; font-size: 9px; opacity: 0.6; }
        .ac-table-footer {
          display: flex; align-items: center; justify-content: space-between;
          padding: 12px 16px; border-top: 1px solid var(--color-border); font-size: 12.5px;
          color: var(--color-text-secondary);
        }
        .ac-page-btn {
          background: none; border: 1px solid var(--color-border); border-radius: 6px;
          padding: 5px 12px; font-size: 12.5px; cursor: pointer; color: var(--color-text-primary);
        }
        .ac-page-btn:disabled { opacity: 0.4; cursor: not-allowed; }
        .ac-page-btn + .ac-page-btn { margin-left: 6px; }
      `}</style>

      {loading ? (
        <LoadingSpinner label="Loading..." />
      ) : rows.length === 0 ? (
        <EmptyState icon={emptyIcon} title={emptyTitle} message={emptyMessage} />
      ) : (
        <>
          <table className="ac-table">
            <thead>
              <tr>
                {columns.map(col => (
                  <th
                    key={col.key}
                    className={`${col.align === 'right' ? 'align-right' : ''} ${col.sortable ? 'sortable' : ''}`}
                    onClick={() => col.sortable && onSort && onSort(col.key)}
                  >
                    {col.label}
                    {col.sortable && sortKey === col.key && (
                      <span className="ac-sort-icon">{sortDir === 'asc' ? '▲' : '▼'}</span>
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr
                  key={row.id ?? row.account_number ?? i}
                  className={onRowClick ? 'clickable' : ''}
                  onClick={() => onRowClick && onRowClick(row)}
                >
                  {columns.map(col => (
                    <td key={col.key} className={col.align === 'right' ? 'align-right' : ''}>
                      {col.render ? col.render(row) : (row[col.key] ?? '—')}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>

          {totalPages > 1 && (
            <div className="ac-table-footer">
              <span>Page {page} of {totalPages}</span>
              <div>
                <button className="ac-page-btn" disabled={page <= 1} onClick={() => onPageChange(page - 1)}>Previous</button>
                <button className="ac-page-btn" disabled={page >= totalPages} onClick={() => onPageChange(page + 1)}>Next</button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}