import { useEffect, useState } from 'react'
import { SearchIcon, SortIcon } from './icons.jsx'
import TabBar from './TabBar.jsx'

// Raw Book2 JSON of one book from MongoDB (server.py GET /books/<id>).
function BookJson({ id, onBack }) {
  const [json, setJson] = useState('')

  useEffect(() => {
    fetch(`/books/${id}`)
      .then((res) => {
        if (!res.ok) throw new Error(`server error ${res.status}`)
        return res.json()
      })
      .then((book) => setJson(JSON.stringify(book, null, 2)))
      .catch((e) => setJson(`Couldn't load book: ${e.message}`))
  }, [id])

  return (
    <div className="container py-3">
      <div className="d-flex align-items-center mb-3">
        <h1 className="h3 me-auto mb-0">Book {id}</h1>
        <button type="button" className="btn btn-outline-light" onClick={onBack}>Back</button>
      </div>
      <pre>{json || 'Loading...'}</pre>
    </div>
  )
}

// Page 1's photo as the cover, or a document-style placeholder if there's no image (e.g. folder deleted).
function Cover({ book }) {
  const [failed, setFailed] = useState(false)
  if (!book.cover || failed) {
    return (
      <span className="cover-doc">
        <span className="cover-doc-tag">BOOK</span>
        <span className="cover-doc-lines" />
        <span className="cover-doc-name">{book.name}</span>
      </span>
    )
  }
  return <img src={`/images/${book.id}/${book.cover}`} alt="" loading="lazy" onError={() => setFailed(true)} />
}

// Kindle-style library of scanned books from MongoDB (server.py GET /books).
export default function Shelf({ onHome, onLibrary, onScan }) {
  const [books, setBooks] = useState(null) // null = loading
  const [error, setError] = useState('')
  const [openId, setOpenId] = useState(null) // book whose JSON is shown
  const [query, setQuery] = useState('')
  const [newestFirst, setNewestFirst] = useState(true)
  const [menuFor, setMenuFor] = useState(null) // book whose options menu is open

  useEffect(() => {
    fetch('/books')
      .then((res) => {
        if (!res.ok) throw new Error(`server error ${res.status}`)
        return res.json()
      })
      .then(setBooks)
      .catch((e) => setError(e.message))
  }, [])

  // Escape closes the options menu.
  useEffect(() => {
    if (!menuFor) return
    const onKey = (e) => e.key === 'Escape' && setMenuFor(null)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [menuFor])

  // Delete from MongoDB (and its page images) after a confirm; can't be undone.
  async function remove(book) {
    if (!window.confirm(`Delete "${book.name}" (${book.pages} pages)? This can't be undone.`)) return
    try {
      const res = await fetch(`/books/${book.id}`, { method: 'DELETE' })
      if (!res.ok && res.status !== 404) throw new Error(`server error ${res.status}`) // 404: already gone
      setBooks((list) => list.filter((b) => b.id !== book.id))
    } catch (e) {
      window.alert(`Couldn't delete: ${e.message}`)
    }
  }

  // the shelf stays mounted underneath, so Back doesn't reload the list
  if (openId) return <BookJson id={openId} onBack={() => setOpenId(null)} />

  const q = query.trim().toLowerCase()
  const shown = (books ?? []).filter((b) => b.name.toLowerCase().includes(q)) // server sends newest first
  if (!newestFirst) shown.reverse()

  return (
    <div className="library">
      <header className="library-head">
        <h1>Library</h1>
        <button type="button" className="library-round" onClick={() => setNewestFirst((v) => !v)}
          aria-label={newestFirst ? 'Sorted newest first; show oldest first' : 'Sorted oldest first; show newest first'}
          title={newestFirst ? 'Newest first' : 'Oldest first'}>{SortIcon}</button>
      </header>

      <label className="library-search">
        {SearchIcon}
        <input type="search" placeholder="Search your shelf" value={query} onChange={(e) => setQuery(e.target.value)} />
      </label>

      {error && <div className="alert alert-danger">Couldn't load books: {error}</div>}
      {!error && !books && <p className="library-note">Loading...</p>}
      {books?.length === 0 && <p className="library-note">No books yet. Tap Scan to add one.</p>}
      {books?.length > 0 && shown.length === 0 && <p className="library-note">No books match "{query}".</p>}

      {/* Bootstrap grid: 3 covers per row on phones (like Kindle), 4 on tablets and up */}
      <div className="row g-3">
        {shown.map((b) => (
          <div className="col-4 col-md-3" key={b.id}>
            <div className="library-book">
              {/* tap: details; right-click / long-press on desktop browsers: options */}
              <button type="button" className="library-cover" aria-label={`${b.name}, ${b.pages} pages`}
                onClick={() => setOpenId(b.id)} onContextMenu={(e) => { e.preventDefault(); setMenuFor(b) }}>
                <Cover book={b} />
              </button>
              <span className="library-tag" aria-hidden="true">{b.pages} pg</span>
              <button type="button" className="library-more" aria-label={`More options for ${b.name}`}
                onClick={() => setMenuFor(b)}>•••</button>
            </div>
          </div>
        ))}
      </div>

      {menuFor && (
        <div className="library-backdrop" onClick={() => setMenuFor(null)}>
          <div className="library-menu" role="menu" aria-label={menuFor.name} onClick={(e) => e.stopPropagation()}>
            <div className="library-menu-title">{menuFor.name}</div>
            <button type="button" role="menuitem" autoFocus onClick={() => { setOpenId(menuFor.id); setMenuFor(null) }}>
              Book Details
            </button>
            <button type="button" role="menuitem" className="library-danger"
              onClick={() => { const b = menuFor; setMenuFor(null); remove(b) }}>
              Permanently Delete
            </button>
          </div>
        </div>
      )}

      <TabBar active="library" onHome={onHome} onLibrary={onLibrary} onScan={onScan} />
    </div>
  )
}
