import { useEffect, useState } from 'react'
import { getJson, request } from '../api.js'
import { TrashIcon } from '../components/icons.jsx'

const NEW = '\u0000new' // speaker <select> value for "+ New character…"
const lines = (page) => page.text.map(({ Character, Dialogue }) => ({ Character, Dialogue }))

// Edit one page's lines (opened from the Pages list, PageList.jsx): its photo and lines; fix each line's text and who
// says it, add/delete/reorder lines. Saves with PUT /books/<id>/pages/<key> (backend/routes/books.py edit_page);
// Back saves first. Other pages are reached from the Pages list, not from here.
export default function BookEditor({ id, index, onBack }) {
  const [book, setBook] = useState(null) // Book2 "Book" object
  const [error, setError] = useState('')
  const [draft, setDraft] = useState([]) // this page's lines being edited: [{Character, Dialogue}]
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    getJson(`/books/${id}`)
      .then((b) => { setBook(b[0].Book); setDraft(lines(Object.values(b[0].Book.Pages)[index])) })
      .catch((e) => setError(e.message))
  }, [id, index])

  if (error) return <div className="container py-3"><div className="alert alert-danger">Couldn't load book: {error}</div>
    <button type="button" className="btn btn-outline-light" onClick={onBack}>Back</button></div>
  if (!book) return <div className="container py-3">Loading...</div>

  const pages = Object.entries(book.Pages) // [[key, page]] in book order, like the reader
  const [key, page] = pages[index]
  const speakers = [...new Set(['Narrator', 'Onomatopoeia', ...book.Characters.map((c) => c.Name), ...draft.map((l) => l.Character)])]

  function change(update) {
    setDraft(update)
    setDirty(true)
  }
  const setLine = (i, field, value) => change((d) => d.map((l, j) => (j === i ? { ...l, [field]: value } : l)))
  const move = (i, to) => change((d) => { const c = [...d]; [c[i], c[to]] = [c[to], c[i]]; return c })

  function pickSpeaker(i, value) {
    if (value !== NEW) return setLine(i, 'Character', value)
    const name = window.prompt('New character name')?.trim()
    if (name) setLine(i, 'Character', name.slice(0, 40))
  }

  // Save this page if changed; false if it failed (then stay on the page).
  async function save() {
    if (!dirty) return true
    setSaving(true)
    try {
      const text = draft.filter((l) => l.Dialogue.trim()) // empty lines are dropped
      const saved = await request(`/books/${id}/pages/${key}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }),
      })
      setBook(saved[0].Book)
      setDraft(lines(saved[0].Book.Pages[key]))
      setDirty(false)
      return true
    } catch (e) {
      window.alert(`Couldn't save this page: ${e.message}`)
      return false
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="container py-3 editor">
      <div className="d-flex align-items-center gap-2 mb-2 flex-wrap">
        <h1 className="h4 me-auto mb-0">Edit {book.Name}</h1>
        <button type="button" className="btn btn-primary" disabled={!dirty || saving} onClick={save}>
          {saving ? 'Saving...' : dirty ? 'Save' : 'Saved'}
        </button>
        <button type="button" className="btn btn-outline-light" onClick={async () => { if (await save()) onBack() }}>Back</button>
      </div>

      <p className="mb-3">Page {index + 1} of {pages.length} <span className="text-secondary">({key})</span></p>

      <img className="editor-photo" src={`/images/${id}/${page.img}`} alt={`${key} photo`} />

      {draft.length === 0 && <p className="text-secondary">No text on this page.</p>}
      {draft.map((l, i) => (
        <div className="editor-line" key={i}>
          <select className={`form-select${l.Character === 'Unknown' ? ' editor-unknown' : ''}`} aria-label={`Line ${i + 1} speaker`} value={l.Character}
            onChange={(e) => pickSpeaker(i, e.target.value)}>
            {speakers.map((s) => <option key={s} value={s}>{s}</option>)}
            <option value={NEW}>+ New character…</option>
          </select>
          <textarea className="form-control" rows={2} aria-label={`Line ${i + 1} text`} value={l.Dialogue}
            onChange={(e) => setLine(i, 'Dialogue', e.target.value)} />
          <div className="editor-tools">
            <button type="button" className="btn btn-sm btn-outline-light" aria-label={`Move line ${i + 1} up`}
              disabled={i === 0} onClick={() => move(i, i - 1)}>↑</button>
            <button type="button" className="btn btn-sm btn-outline-light" aria-label={`Move line ${i + 1} down`}
              disabled={i === draft.length - 1} onClick={() => move(i, i + 1)}>↓</button>
            <button type="button" className="btn btn-sm btn-outline-danger" aria-label={`Delete line ${i + 1}`}
              onClick={() => change((d) => d.filter((_, j) => j !== i))}>{TrashIcon}</button>
          </div>
        </div>
      ))}
      <button type="button" className="btn btn-outline-light mt-2"
        onClick={() => change((d) => [...d, { Character: 'Narrator', Dialogue: '' }])}>+ Add line</button>
    </div>
  )
}
