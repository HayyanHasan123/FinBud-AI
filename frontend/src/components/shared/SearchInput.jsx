import { useState, useRef, useEffect } from 'react'

// <SearchInput
//   placeholder="Search users by name, email, or account number..."
//   onSearch={async (query) => await adminGet(`/activity/search-users?q=${query}`)}
//   renderResult={(u) => <><strong>{u.name}</strong><span>{u.account_number}</span></>}
//   onSelect={(u) => loadUser(u.account_number)}
// />
// Owns its own text state + 300ms debounce; the caller only supplies an
// async search function and a result renderer, so every page's user-lookup
// box behaves identically.
export default function SearchInput({
  placeholder = 'Search...',
  onSearch,
  renderResult,
  onSelect,
  debounceMs = 300,
  minChars = 1
}) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState([])
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const timeoutRef = useRef(null)
  const wrapRef = useRef(null)

  useEffect(() => {
    function handleOutside(e) {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', handleOutside)
    return () => document.removeEventListener('mousedown', handleOutside)
  }, [])

  function handleChange(v) {
    setQuery(v)
    clearTimeout(timeoutRef.current)
    if (v.trim().length < minChars) { setResults([]); setOpen(false); return }
    timeoutRef.current = setTimeout(async () => {
      setLoading(true)
      try {
        const r = await onSearch(v.trim())
        setResults(Array.isArray(r) ? r : [])
        setOpen(true)
      } catch {
        setResults([])
      }
      setLoading(false)
    }, debounceMs)
  }

  function handleSelect(item) {
    onSelect(item)
    setOpen(false)
    setQuery('')
    setResults([])
  }

  return (
    <div className="ac-search-wrap" ref={wrapRef}>
      <style>{`
        .ac-search-wrap { position: relative; }
        .ac-search-input {
          width: 100%; padding: 9px 14px 9px 34px; border: 1px solid var(--color-border);
          border-radius: var(--radius-sm); font-size: 13px; background: var(--color-content-bg);
          outline: none; color: var(--color-text-primary);
        }
        .ac-search-input:focus { border-color: var(--color-primary); background: #fff; }
        .ac-search-icon { position: absolute; left: 12px; top: 50%; transform: translateY(-50%); color: var(--color-text-muted); font-size: 13px; }
        .ac-search-dropdown {
          position: absolute; top: 42px; left: 0; width: 100%; min-width: 260px;
          background: var(--color-card-bg); border-radius: 8px; box-shadow: var(--shadow-modal);
          z-index: 60; max-height: 320px; overflow-y: auto;
        }
        .ac-search-row { padding: 10px 14px; cursor: pointer; font-size: 13px; border-bottom: 1px solid var(--color-border); }
        .ac-search-row:last-child { border-bottom: none; }
        .ac-search-row:hover { background: var(--color-content-bg); }
        .ac-search-empty { padding: 14px; font-size: 12.5px; color: var(--color-text-muted); text-align: center; }
      `}</style>
      <i className="fas fa-magnifying-glass ac-search-icon" />
      <input
        className="ac-search-input"
        placeholder={placeholder}
        value={query}
        onChange={e => handleChange(e.target.value)}
        onFocus={() => results.length > 0 && setOpen(true)}
      />
      {open && (
        <div className="ac-search-dropdown">
          {loading && <div className="ac-search-empty">Searching...</div>}
          {!loading && results.length === 0 && <div className="ac-search-empty">No matches found.</div>}
          {!loading && results.map((item, i) => (
            <div key={item.account_number || item.id || i} className="ac-search-row" onClick={() => handleSelect(item)}>
              {renderResult(item)}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}