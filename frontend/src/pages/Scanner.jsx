import { useEffect, useRef, useState } from 'react'
import { remove, timing } from '../api.js'
import { snap, startCamera, watchMotion } from '../camera.js'
import { cancel as cancelUploads, enqueue, progress, useScanQueue } from '../scanQueue.js'

const ZOOMS = [1, 1.5, 2] // the zoom button steps through these: whole frame, then closer crops of its middle
const STEPS = [ // what to do next, by how many photos are taken
  'Scan the front cover of the book.',
  'Open to the first page where the story begins.',
  'Turn to the next page, or tap Done to finish.',
]

export default function Scanner({ bookId, onDone, onCancel }) {
  const videoRef = useRef(null)
  const needTurn = useRef(false) // a page was taken: wait for the next turn before the next photo
  const [status, setStatus] = useState('Starting camera...')
  const [ready, setReady] = useState(false)
  const [motion, setMotion] = useState(0)
  const [toast, setToast] = useState('')
  const [taken, setTaken] = useState([]) // labels of the photos taken, in order
  const [ratio, setRatio] = useState(4 / 3)
  const [zoom, setZoom] = useState(1.5) // one of ZOOMS
  useScanQueue() // re-render as pages finish processing
  const { done = 0, failed = 0, total = 0 } = progress(bookId) ?? {}

  // Start the camera once; stop it when the component unmounts.
  useEffect(() => {
    const video = videoRef.current
    return startCamera(
      video,
      { video: { facingMode: 'user', width: { ideal: 4032 }, height: { ideal: 3024 }, aspectRatio: { ideal: 4 / 3 } }, audio: false },
      () => {
        setStatus(`Camera ready (${video.videoWidth}×${video.videoHeight})`)
        setRatio(video.videoWidth / video.videoHeight)
        setReady(true)
      },
      (e) => setStatus(`Camera unavailable: ${e.name}`),
    )
  }, [])

  // A photo is sent right away in the background (scanQueue.js, several at once), so the camera is free for the next
  // page and processing carries on after Done.
  const count = useRef(0) // photos so far, for labels (state updates lag behind)
  function add(photo, t) {
    URL.revokeObjectURL(photo.url)
    const i = count.current++
    const label = i ? `Page ${i}` : 'Cover'
    setTaken((list) => [...list, label])
    setToast(`${label} taken`)
    setTimeout(() => setToast(''), 1500)
    const takenAt = performance.now()
    enqueue(bookId, i, photo.blob, (reply, err, sentAt) => {
      // where the time went (timing() in api.js); queued = waiting for a free upload slot
      if (reply) {
        console.log('[scan]', label, `-> ${reply.page} (${Math.round(photo.blob.size / 1024)} KB) |`,
          timing({ ...t, queued: sentAt - takenAt }, reply.times, performance.now() - sentAt))
      } else console.log('[scan]', label, 'failed twice:', err) // the backend prints its step times
    })
  }

  // Cancel scanning: drop this book from the DB (JSON and page images) and leave.
  async function cancel() {
    const n = taken.length
    if (n && !window.confirm(`Discard this book and its ${n} scanned page${n === 1 ? '' : 's'}?`)) return
    try {
      await cancelUploads(bookId) // pages still waiting aren't sent; the one uploading finishes first
      await remove(`/books/${bookId}`) // nothing saved yet counts as done
      onCancel()
    } catch (e) {
      window.alert(`Couldn't discard the book: ${e.message}`)
    }
  }

  // Auto-capture: wait for motion (page turn), then snap once it has been still for 1 s.
  useEffect(() => {
    if (!ready) return
    const video = videoRef.current
    let moving = !needTurn.current
    let movedAt = moving ? performance.now() : null // first motion, for the [scan] stage times
    let stillSince = null
    return watchMotion(video, (score) => {
      setMotion(score)
      if (score > 12) {
        movedAt ??= performance.now()
        moving = true
      }
      if (score >= 8) stillSince = null
      else if (moving) {
        stillSince ??= performance.now()
        if (performance.now() - stillSince >= 1000) {
          moving = false
          needTurn.current = true
          const snapAt = performance.now()
          // flip: first motion -> settling began; settle: the still wait; snap: photo encode
          const t = { flip: stillSince - movedAt, settle: snapAt - stillSince }
          movedAt = null
          snap(video, (p) => add(p, { ...t, snap: performance.now() - snapAt }), { zoom })
        }
      }
    }, zoom)
  }, [ready, zoom]) // eslint-disable-line react-hooks/exhaustive-deps -- add only uses refs, setters and bookId

  const processing = total - done - failed
  const last = taken.at(-1)

  return (
    <main className="scan" style={{ '--ratio': ratio }}>
      <header className="scan-head">
        <h1>Scanning</h1>
        <p className="scan-count">
          <strong>{done}</strong> saved{processing ? ` · ${processing} processing` : ''}{failed ? ` · ${failed} failed` : ''}
        </p>
      </header>
      <p className="scan-status">{status}{ready && ` · motion ${motion.toFixed(1)}%`}</p>

      <div className="scan-stage">
        <div className="scan-view">
          <video ref={videoRef} autoPlay playsInline muted style={{ transform: `scale(-${zoom}, ${zoom})` }} /* mirrored and zoomed, same as snap() */ />
          {taken.length > 0 && <div className="scan-flash" key={`flash${taken.length}`} />}
          <section className="scan-guide" aria-live="polite" key={taken.length} /* re-keyed so each message fades in */>
            <p className="scan-guide-text">{last ? `✓ ${last} taken. ` : ''}{STEPS[Math.min(taken.length, STEPS.length - 1)]}</p>
          </section>
        </div>
      </div>

      <div className="scan-controls">
        <button type="button" className="scan-cancel" onClick={cancel}>Cancel</button>
        <div className="scan-center" /* photos are taken automatically once the page is still */>
          <button type="button" className="scan-zoom" aria-pressed={zoom !== 1} aria-label={`Zoom ${zoom}×, tap to change`}
            onClick={() => setZoom(ZOOMS[(ZOOMS.indexOf(zoom) + 1) % ZOOMS.length])}>x{zoom}</button>
        </div>
        {/* pages still processing carry on in the background; the Library shows how many are ready */}
        <button type="button" className="scan-done" disabled={taken.length < 2} onClick={onDone}>Done</button>
      </div>

      {toast && <div className="scan-toast" role="status">{toast}</div>}
    </main>
  )
}
