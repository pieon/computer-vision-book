import { useRef, useState } from 'react'
import { request } from '../api.js'

const OUT = 256 // px, the saved square crop

// Full-screen crop of a character's face from a page picture: pinch / wheel / slider to zoom, drag to move, ‹ › for
// another page. Use saves what's inside the square frame (PUT /books/<id>/face) and calls onDone(img file).
export default function Cropper({ id, name, pages, start, onDone, onCancel }) {
  const [page, setPage] = useState(Math.max(0, pages.indexOf(start)))
  const [view, setView] = useState({ x: 0, y: 0, s: 1 })
  const [saving, setSaving] = useState(false)
  const imgRef = useRef(null)
  const frameRef = useRef(null)
  const pointers = useRef(new Map()) // pointerId -> { x, y }
  const zoom = (s) => setView((v) => ({ ...v, s: Math.min(6, Math.max(1, s)) }))

  function turn(d) {
    setPage((p) => (p + d + pages.length) % pages.length)
    setView({ x: 0, y: 0, s: 1 })
  }

  function onPointerDown(e) {
    e.currentTarget.setPointerCapture(e.pointerId)
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
  }
  function onPointerMove(e) {
    const ps = pointers.current
    const prev = ps.get(e.pointerId)
    if (!prev) return
    if (ps.size === 1) {
      setView((v) => ({ ...v, x: v.x + e.clientX - prev.x, y: v.y + e.clientY - prev.y }))
    } else {
      const [a, b] = [...ps.values()]
      const before = Math.hypot(a.x - b.x, a.y - b.y)
      ps.set(e.pointerId, { x: e.clientX, y: e.clientY })
      const [c, d] = [...ps.values()]
      setView((v) => ({ ...v, s: Math.min(6, Math.max(1, v.s * (Math.hypot(c.x - d.x, c.y - d.y) / (before || 1)))) }))
    }
    ps.set(e.pointerId, { x: e.clientX, y: e.clientY })
  }
  const onPointerUp = (e) => pointers.current.delete(e.pointerId)

  async function use() {
    const img = imgRef.current
    const r = img.getBoundingClientRect()
    const f = frameRef.current.getBoundingClientRect()
    const k = img.naturalWidth / r.width // screen px -> image px
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = OUT
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, OUT, OUT)
    ctx.drawImage(img, (f.left - r.left) * k, (f.top - r.top) * k, f.width * k, f.height * k, 0, 0, OUT, OUT)
    setSaving(true)
    try {
      const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.85))
      const { img: file } = await request(`/books/${id}/face?${new URLSearchParams({ name })}`, { method: 'PUT', body: blob })
      onDone(file)
    } catch (e) {
      alert(`Couldn't save the picture: ${e.message}`)
      setSaving(false)
    }
  }

  return (
    <div className="cropper" role="dialog" aria-label={`Crop ${name}'s picture`}>
      <div className="cropper-bar">
        <button type="button" className="btn btn-outline-light" onClick={onCancel}>Cancel</button>
        <span className="me-auto">{name}</span>
        <button type="button" className="btn btn-primary" disabled={saving} onClick={use}>Use</button>
      </div>
      <div className="cropper-stage" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp} onWheel={(e) => zoom(view.s * (e.deltaY < 0 ? 1.1 : 1 / 1.1))}>
        <img ref={imgRef} src={`/images/${id}/${pages[page]}`} alt={`Page ${page + 1}`} draggable={false}
          style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.s})` }} />
        <span ref={frameRef} className="cropper-frame" aria-hidden="true" />
      </div>
      <div className="cropper-bar">
        <button type="button" className="btn btn-outline-light" aria-label="Previous page" onClick={() => turn(-1)}>‹</button>
        <input type="range" className="form-range" min="1" max="6" step="0.05" value={view.s} aria-label="Zoom"
          onChange={(e) => zoom(+e.target.value)} />
        <button type="button" className="btn btn-outline-light" aria-label="Next page" onClick={() => turn(1)}>›</button>
      </div>
      <p className="cropper-hint">Pinch or slide to zoom, drag to move. Page {page + 1} of {pages.length}</p>
    </div>
  )
}
