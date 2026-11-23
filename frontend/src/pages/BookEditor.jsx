import { useEffect, useRef, useState } from 'react'
import { getJson, remove, request } from '../api.js'
import { PauseIcon, PlayIcon, TrashIcon } from '../components/icons.jsx'

const NEW = '\u0000new' // speaker <select> value for "+ New character…"
const lines = (page) => page.text.map(({ Character, Dialogue }) => ({ Character, Dialogue }))

// The page's sound effects (picked from Freesound at scan time, backend/pipeline/book/sounds.py) to review: play each,
// remove one that doesn't fit (it's never picked for this book again), or pick the page's sounds again.
function PageSounds({ id, pageKey, page, onChange }) {
  const [busy, setBusy] = useState(false)
  const [playing, setPlaying] = useState(null) // id of the sound previewing now
  const audio = useRef(null)
  useEffect(() => () => audio.current?.pause(), [])
  const sounds = page.sounds ?? { setting: null, lines: {} }
  const rows = [
    ...(sounds.setting ? [['setting', 'Background', sounds.setting]] : []),
    ...Object.entries(sounds.lines).map(([i, s]) => [i, `Line ${+i + 1}, on "${s.word}"`, s]),
  ]
  function stop() {
    audio.current?.pause()
    setPlaying(null)
  }
  // Play / Pause: one preview at a time; playing another stops the last
  function toggle(sound) {
    if (playing === sound.id) return stop()
    stop()
    const a = new Audio(`/sounds/file/${sound.id}.mp3`)
    a.onended = () => setPlaying((p) => (p === sound.id ? null : p))
    audio.current = a
    setPlaying(sound.id)
    a.play().catch((e) => { console.log('[sfx] preview failed:', e); setPlaying(null) })
  }
  function drop(slot) {
    stop()
    remove(`/books/${id}/pages/${pageKey}/sounds/${slot}`)
      .catch((e) => window.alert(`Couldn't remove it: ${e.message}`))
      .then(() => getJson(`/books/${id}`)).then((b) => b && onChange(b[0].Book.Pages[pageKey].sounds))
  }
  function again() {
    setBusy(true)
    request(`/books/${id}/pages/${pageKey}/sounds`, { method: 'POST' })
      .then(onChange)
      .catch((e) => window.alert(`Couldn't pick sounds: ${e.message}`))
      .finally(() => setBusy(false))
  }
  return (
    <section className="editor-sounds" aria-label="Sound effects">
      <div className="d-flex align-items-center gap-2 flex-wrap">
        <h2 className="h5 me-auto mb-0">Sounds</h2>
        <button type="button" className="btn btn-sm btn-outline-light" disabled={busy} onClick={again}>
          {busy ? 'Picking...' : 'Pick again'}
        </button>
      </div>
      <p className="text-secondary small mb-2">Picked automatically from Freesound for the narrator's lines; remove any that don't fit. Editing the lines picks them again.</p>
      {rows.length === 0 && <p className="text-secondary">No sounds on this page.</p>}
      {rows.map(([slot, label, s]) => (
        <div className="editor-sound" key={slot}>
          <div className="editor-sound-what">
            <strong>{label}</strong>: {s.keyword}
            <span className="text-secondary"> · {s.name} by {s.user}</span>
          </div>
          <button type="button" className="btn btn-sm btn-outline-light" aria-label={`${playing === s.id ? 'Pause' : 'Play'} ${label}`}
            onClick={() => toggle(s)}>{playing === s.id ? PauseIcon : PlayIcon}</button>
          <button type="button" className="btn btn-sm btn-outline-danger" aria-label={`Remove ${label}`}
            onClick={() => drop(slot)}>{TrashIcon}</button>
        </div>
      ))}
    </section>
  )
}

// Edit one page's lines (opened from the Pages list, PageList.jsx): its photo and lines; fix each line's text and who
// says it, add/delete/reorder lines. Saves with PUT /books/<id>/pages/<key> (backend/routes/books.py edit_page);
// Back saves first. Other pages are reached from the Pages list, not from here.
export default function BookEditor({ id, index, onBack }) {
  const [book, setBook] = useState(null) // Book2 "Book" object
  const [error, setError] = useState('')
  const [draft, setDraft] = useState([]) // this page's lines being edited: [{Character, Dialogue}]
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [dragging, setDragging] = useState(null) // index of the line being dragged by its grip, or null

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
  const move = (i, to) => change((d) => { const c = [...d]; c.splice(to, 0, ...c.splice(i, 1)); return c })

  // Dragging a line by its grip (far left): pointer events, since iPad Safari has no HTML drag and drop for touch. The
  // line moves live to the row under the finger; arrow keys on the grip move it one row.
  function dragTo(e) {
    if (dragging === null) return
    const rows = [...e.currentTarget.closest('.editor').querySelectorAll('.editor-line')]
    const under = rows.findIndex((r) => e.clientY < r.getBoundingClientRect().bottom)
    const to = under < 0 ? rows.length - 1 : under
    if (to !== dragging) {
      move(dragging, to)
      setDragging(to)
    }
  }
  const stopDrag = () => setDragging(null)

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
        <div className={`editor-line${dragging === i ? ' dragging' : ''}`} key={i}>
          <div className="editor-grip" role="button" tabIndex={0} aria-label={`Move line ${i + 1}: drag, or use the arrow keys`}
            onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); setDragging(i) }}
            onPointerMove={dragTo} onPointerUp={stopDrag} onPointerCancel={stopDrag}
            onKeyDown={(e) => {
              const to = { ArrowUp: i - 1, ArrowDown: i + 1 }[e.key]
              if (to === undefined) return
              e.preventDefault()
              if (to >= 0 && to < draft.length) move(i, to)
            }}>⋮⋮</div>
          <select className={`form-select${l.Character === 'Unknown' ? ' editor-unknown' : ''}`} aria-label={`Line ${i + 1} speaker`} value={l.Character}
            onChange={(e) => pickSpeaker(i, e.target.value)}>
            {speakers.map((s) => <option key={s} value={s}>{s}</option>)}
            <option value={NEW}>+ New character…</option>
          </select>
          <textarea className="form-control" rows={2} aria-label={`Line ${i + 1} text`} value={l.Dialogue}
            onChange={(e) => setLine(i, 'Dialogue', e.target.value)} />
          <div className="editor-tools">
            <button type="button" className="btn btn-sm btn-outline-danger" aria-label={`Delete line ${i + 1}`}
              onClick={() => change((d) => d.filter((_, j) => j !== i))}>{TrashIcon}</button>
          </div>
        </div>
      ))}
      <button type="button" className="btn btn-outline-light mt-2"
        onClick={() => change((d) => [...d, { Character: 'Narrator', Dialogue: '' }])}>+ Add line</button>

      <PageSounds id={id} pageKey={key} page={page}
        onChange={(sounds) => setBook((b) => ({ ...b, Pages: { ...b.Pages, [key]: { ...b.Pages[key], sounds } } }))} />
    </div>
  )
}
