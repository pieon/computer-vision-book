import { useEffect, useState } from 'react'
import { getJson, request } from '../api.js'
import { FlagIcon, TrashIcon } from '../components/icons.jsx'
import ScanProgress from '../components/ScanProgress.jsx'
import { landed, scanning, useScanQueue } from '../scanQueue.js'

// Edit Book: every page of a book as a row (scan thumbnail + page number); tap one to edit its lines (BookEditor.jsx),
// drag it by its grip to another place, delete it, or scan more pages onto the end. Pages with a line whose speaker is "Unknown" are
// flagged. Each change is saved right away (backend/routes/books.py reorder_pages / delete_page).
export default function PageList({ id, onBack, onOpen, onAdd }) {
  const [book, setBook] = useState(null) // Book2 "Book" object
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [dragging, setDragging] = useState(null) // index of the page being dragged by its grip, or null
  const [order, setOrder] = useState(null) // page keys while dragging / saving a new order; null = the book's order
  useScanQueue() // re-render as added pages are prepared
  const pagesIn = landed() // reload below only when one lands, not on every progress poll
  // pages are placed by position as they upload, so moving or deleting meanwhile would put them in the wrong slot
  const uploading = scanning().includes(id)

  useEffect(() => {
    getJson(`/books/${id}`).then((b) => setBook(b[0].Book)).catch((e) => setError(e.message))
  }, [id, pagesIn])

  if (error) return <div className="container py-3"><div className="alert alert-danger">Couldn't load book: {error}</div>
    <button type="button" className="btn btn-outline-light" onClick={onBack}>Back</button></div>
  if (!book) return <div className="container py-3">Loading...</div>

  const saved = Object.keys(book.Pages)
  const pages = (order ?? saved).map((k) => [k, book.Pages[k]]) // [[key, page]] in book order (or as being dragged)
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
  // Save a new page order; the rows stay in it until the server replies (then the book has it), or go back if it fails.
  function saveOrder(keys) {
    if (keys.join() === saved.join()) return setOrder(null)
    setOrder(keys)
    apply(`/books/${id}/order`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ order: keys }) }, 'move the page')
      .finally(() => setOrder(null))
  }
  const moved = (keys, i, to) => { const c = [...keys]; c.splice(to, 0, ...c.splice(i, 1)); return c }

  // Dragging a page by its grip (far left), as Edit Book's lines (BookEditor.jsx): pointer events, since iPad Safari has
  // no HTML drag and drop for touch. The row moves live to the row under the finger; the order is saved on release.
  // Arrow keys on the grip move it one row and save.
  function dragTo(e) {
    if (dragging === null) return
    const rows = [...e.currentTarget.closest('.editor').querySelectorAll('.pages-row')]
    const under = rows.findIndex((r) => e.clientY < r.getBoundingClientRect().bottom)
    const to = under < 0 ? rows.length - 1 : under
    if (to !== dragging) {
      setOrder(moved(pages.map(([k]) => k), dragging, to))
      setDragging(to)
    }
  }
  function stopDrag() {
    if (dragging === null) return
    setDragging(null)
    saveOrder(pages.map(([k]) => k))
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
  function del(i) {
    if (!window.confirm(`Delete page ${i + 1} and its photo? This can't be undone.`)) return
    apply(`/books/${id}/pages/${pages[i][0]}`, { method: 'DELETE' }, 'delete the page')
  }

  return (
    <div className="container py-3 editor">
      <div className="d-flex align-items-center gap-2 mb-3">
        {/* the title comes from the cover's lines: edit page 1 to change it (backend/routes/books.py edit_page) */}
        <h1 className="h4 me-auto mb-0">{book.Name}</h1>
        <button type="button" className="btn btn-outline-light" onClick={onBack}>Back</button>
      </div>
      <ScanProgress id={id} />
      {uploading && <p className="text-secondary">New pages are being prepared; moving and deleting unlock when they're done.</p>}

      {pages.some(([, p]) => p.flagged) && <p className="pages-flag-note">Flagged pages were marked while reading. Tap the flag to clear it once fixed.</p>}
      {unknown > 0 && <p className="pages-unknown-note">Pages marked "Unknown" have a line whose speaker needs fixing. Tap one to fix it.</p>}
      {pages.map(([key, page], i) => {
        const unknownLines = page.text.filter((l) => l.Character === 'Unknown').length
        return (
        <div className={`editor-line pages-row${dragging === i ? ' dragging' : ''}`} key={key + page.img}>
          <div className="editor-grip" role="button" tabIndex={locked ? -1 : 0} aria-disabled={locked}
            aria-label={`Move page ${i + 1}: drag, or use the arrow keys`}
            onPointerDown={(e) => { if (locked) return; e.currentTarget.setPointerCapture(e.pointerId); setDragging(i) }}
            onPointerMove={dragTo} onPointerUp={stopDrag} onPointerCancel={stopDrag}
            onKeyDown={(e) => {
              const to = { ArrowUp: i - 1, ArrowDown: i + 1 }[e.key]
              if (to === undefined || locked) return
              e.preventDefault()
              if (to >= 0 && to < pages.length) saveOrder(moved(saved, i, to))
            }}>⋮⋮</div>
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
