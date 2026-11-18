import { useEffect, useState } from 'react'
import { getJson, request } from '../api.js'
import { FlagIcon, TrashIcon } from '../components/icons.jsx'
import { scanning, useScanQueue } from '../scanQueue.js'

// Edit Book: every page of a book as a row (scan thumbnail + page number); tap one to edit its lines (BookEditor.jsx),
// move it up/down, delete it, or scan more pages onto the end. Pages with a line whose speaker is "Unknown" are
// flagged. Each change is saved right away (backend/routes/books.py reorder_pages / delete_page).
export default function PageList({ id, onBack, onOpen, onAdd }) {
  const [book, setBook] = useState(null) // Book2 "Book" object
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [naming, setNaming] = useState(null) // the title being typed, or null when not renaming
  const queue = useScanQueue() // re-render (and reload below) as added pages finish
  // pages are placed by position as they upload, so moving or deleting meanwhile would put them in the wrong slot
  const uploading = scanning().includes(id)

  useEffect(() => {
    getJson(`/books/${id}`).then((b) => setBook(b[0].Book)).catch((e) => setError(e.message))
  }, [id, queue])

  if (error) return <div className="container py-3"><div className="alert alert-danger">Couldn't load book: {error}</div>
    <button type="button" className="btn btn-outline-light" onClick={onBack}>Back</button></div>
  if (!book) return <div className="container py-3">Loading...</div>

  const pages = Object.entries(book.Pages) // [[key, page]] in book order
  const locked = busy || uploading
  const unknown = pages.filter(([, p]) => p.text.some((l) => l.Character === 'Unknown')).length

  async function apply(url, options, what) {
    setBusy(true)
    try {
      setBook((await request(url, options))[0].Book)
    } catch (e) {
      window.alert(`Couldn't ${what}: ${e.message}`)
    } finally {
      setBusy(false)
    }
  }
  function move(i, to) {
    const order = pages.map(([k]) => k);
    [order[i], order[to]] = [order[to], order[i]]
    apply(`/books/${id}/order`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ order }) }, 'move the page')
  }
  async function unflag(i) {
    const [key, page] = pages[i]
    try {
      await request(`/books/${id}/pages/${key}/flag`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ flagged: false }),
      })
      setBook((b) => ({ ...b, Pages: { ...b.Pages, [key]: { ...page, flagged: false } } }))
    } catch (e) {
      window.alert(`Couldn't clear the flag: ${e.message}`)
    }
  }
  // Tap the title to rename: Enter or leaving the box saves, Escape cancels; blank or unchanged saves nothing.
  async function rename() {
    const name = naming?.trim()
    setNaming(null)
    if (!name || name === book.Name) return
    const old = book.Name
    setBook((b) => ({ ...b, Name: name }))
    try {
      await request(`/books/${id}/name`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) })
    } catch (e) {
      setBook((b) => ({ ...b, Name: old }))
      window.alert(`Couldn't rename the book: ${e.message}`)
    }
  }
  function del(i) {
    if (!window.confirm(`Delete page ${i + 1} and its photo? This can't be undone.`)) return
    apply(`/books/${id}/pages/${pages[i][0]}`, { method: 'DELETE' }, 'delete the page')
  }

  return (
    <div className="container py-3 editor">
      <div className="d-flex align-items-center gap-2 mb-3">
        {naming === null ? (
          <h1 className="h4 me-auto mb-0">
            <button type="button" className="pages-title" onClick={() => setNaming(book.Name)}
              aria-label={`${book.Name}. Tap to rename`} title="Tap to rename">{book.Name}</button>
          </h1>
        ) : (
          <input className="form-control me-auto pages-title-input" aria-label="Book title" autoFocus maxLength={120}
            value={naming} onChange={(e) => setNaming(e.target.value)} onBlur={rename}
            onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') setNaming(null) }} />
        )}
        <button type="button" className="btn btn-outline-light" onClick={onBack}>Back</button>
      </div>
      {uploading && <p className="text-secondary" role="status">New pages are still uploading; moving and deleting unlock when they're done.</p>}

      {pages.some(([, p]) => p.flagged) && <p className="pages-flag-note">Flagged pages were marked while reading. Tap the flag to clear it once fixed.</p>}
      {unknown > 0 && <p className="pages-unknown-note">Pages marked "Unknown" have a line whose speaker needs fixing. Tap one to fix it.</p>}
      {pages.map(([key, page], i) => {
        const unknownLines = page.text.filter((l) => l.Character === 'Unknown').length
        return (
        <div className="editor-line pages-row" key={key + page.img}>
          <button type="button" className="pages-open" onClick={() => onOpen(i)}
            aria-label={`Edit lines of page ${i + 1}${unknownLines ? `, ${unknownLines} unknown speaker${unknownLines > 1 ? 's' : ''}` : ''}`}>
            <img className="pages-thumb" src={`/images/${id}/${page.img}`} alt="" loading="lazy" />
            <span>
              Page {i + 1}{i === 0 && <span className="text-secondary"> · Cover</span>}
              {unknownLines > 0 && <span className="pages-unknown">Unknown ×{unknownLines}</span>}
            </span>
          </button>
          {page.flagged && (
            <button type="button" className="pages-flag" onClick={() => unflag(i)} disabled={busy}
              aria-label={`Page ${i + 1} is flagged; clear the flag`} title="Clear the flag">{FlagIcon}</button>
          )}
          <div className="editor-tools">
            <button type="button" className="btn btn-sm btn-outline-light" aria-label={`Move page ${i + 1} up`}
              disabled={i === 0 || locked} onClick={() => move(i, i - 1)}>↑</button>
            <button type="button" className="btn btn-sm btn-outline-light" aria-label={`Move page ${i + 1} down`}
              disabled={i === pages.length - 1 || locked} onClick={() => move(i, i + 1)}>↓</button>
            <button type="button" className="btn btn-sm btn-outline-danger" aria-label={`Delete page ${i + 1}`}
              title={pages.length === 1 ? "A book's only page can't be deleted" : undefined}
              disabled={pages.length === 1 || locked} onClick={() => del(i)}>{TrashIcon}</button>
          </div>
        </div>
        )
      })}
      <button type="button" className="btn btn-outline-light mt-2" disabled={locked} onClick={() => onAdd(pages.length)}>+ Add page</button>
    </div>
  )
}
