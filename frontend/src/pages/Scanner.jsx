import { useEffect, useRef, useState } from 'react'
import { remove, timing } from '../api.js'
import { BAND, BandLine } from '../BandLine.jsx'
import { snap, startCamera, watchMotion } from '../camera.js'
import { cancel as cancelUploads, enqueue, progress, useScanQueue } from '../scanQueue.js'

const SETTLE_MS = 2000 // the page must be still (motion < 8%) this long before the photo; was 1000, too quick
const STEPS = [ // what to do next, by how many photos are taken
  'Scan the front cover of the book.',
  'Open to the first page where the story begins.',
  'Turn to the next page, or tap Done to finish.',
]

// start: the first page position to fill. 0 = a new book (cover first); > 0 = adding pages to the end of a book.
// First the setup: the user drags two lines to the top and bottom of the book and confirms; then every photo is cut to
// that band before it's sent, so the table and lap never reach the unwarp, OCR or the page fingerprints.
export default function Scanner({ bookId, start = 0, onDone, onCancel }) {
  const videoRef = useRef(null)
  const needTurn = useRef(false) // a page was taken: wait for the next turn before the next photo
  const [status, setStatus] = useState('Starting camera...')
  const [ready, setReady] = useState(false)
  const [motion, setMotion] = useState(0)
  const [toast, setToast] = useState('')
  const [taken, setTaken] = useState([]) // labels of the photos taken, in order
  const [ratio, setRatio] = useState(4 / 3)
  const [phase, setPhase] = useState('setup') // 'setup': placing the band lines; 'scan': taking photos
  const [band, setBand] = useState(BAND) // { top, bottom } of the book, fractions of the frame height
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
  const count = useRef(start) // next page position, for labels (state updates lag behind)
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

  // Cancel scanning: leave right away and drop this book from the DB (JSON and page images) in the background; the
  // server drops pages still processing for it (backend/routes/scan.py). If that fails the book shows in the Library.
  // Adding to an existing book: just stop; photos not uploaded yet are dropped, pages already saved stay.
  function cancel() {
    const n = taken.length
    if (start) {
      if (n && !window.confirm('Stop adding pages? Photos not uploaded yet are dropped; pages already saved stay in the book.')) return
      cancelUploads(bookId)
      return onCancel()
    }
    if (n && !window.confirm(`Discard this book and its ${n} scanned page${n === 1 ? '' : 's'}?`)) return
    cancelUploads(bookId)
    remove(`/books/${bookId}`).catch((e) => console.warn(`[scan] couldn't discard book ${bookId}:`, e)) // 404 counts as done
    onCancel()
  }

  // Auto-capture: wait for motion (page turn) inside the band, then snap once it has been still for SETTLE_MS.
  // Only while scanning; the band can't change then.
  useEffect(() => {
    if (!ready || phase !== 'scan') return
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
        if (performance.now() - stillSince >= SETTLE_MS) {
          moving = false
          needTurn.current = true
          const snapAt = performance.now()
          // flip: first motion -> settling began; settle: the still wait; snap: photo encode
          const t = { flip: stillSince - movedAt, settle: snapAt - stillSince }
          movedAt = null
          snap(video, (p) => add(p, { ...t, snap: performance.now() - snapAt }), { band })
        }
      }
    }, band)
  }, [ready, phase]) // eslint-disable-line react-hooks/exhaustive-deps -- band is fixed while scanning; add only uses refs, setters and bookId

  const processing = total - done - failed
  const last = taken.at(-1)
  const setup = phase === 'setup'
  const guide = setup
    ? 'Drag the lines to the top and bottom of the book, then tap Confirm.'
    : `${last ? `✓ ${last} taken. ` : ''}${start && !taken.length ? 'Open to the page you want to add.' : STEPS[Math.min(start + taken.length, STEPS.length - 1)]}`

  return (
    <main className="scan" style={{ '--ratio': ratio }}>
      <header className="scan-head">
        <h1>{start ? 'Adding pages' : 'Scanning'}</h1>
        <p className="scan-count">
          <strong>{done}</strong> saved{processing ? ` · ${processing} processing` : ''}{failed ? ` · ${failed} failed` : ''}
        </p>
      </header>
      <p className="scan-status">{status}{ready && !setup && ` · motion ${motion.toFixed(1)}%`}</p>

      <div className="scan-stage">
        <div className="scan-view">
          <video ref={videoRef} autoPlay playsInline muted /* mirrored in CSS, same as snap() */ />
          {ready && <>
            {/* outside the band is darker: that part of the frame is cut off every photo */}
            <div className="scan-shade" style={{ top: 0, height: `${band.top * 100}%` }} />
            <div className="scan-shade" style={{ top: `${band.bottom * 100}%`, bottom: 0 }} />
            <BandLine which="top" band={band} setBand={setBand} fixed={!setup} />
            <BandLine which="bottom" band={band} setBand={setBand} fixed={!setup} />
          </>}
          {taken.length > 0 && <div className="scan-flash" key={`flash${taken.length}`} />}
          <section className="scan-guide" aria-live="polite" key={`${phase}${taken.length}`} /* re-keyed so each message fades in */>
            <p className="scan-guide-text">{guide}</p>
          </section>
        </div>
      </div>

      <div className="scan-controls">
        <button type="button" className="scan-cancel" onClick={cancel}>Cancel</button>
        <div /* photos are taken automatically once the page is still */ />
        {setup
          ? <button type="button" className="scan-done" disabled={!ready} onClick={() => setPhase('scan')}>Confirm</button>
          /* pages still processing carry on in the background; the Library shows how many are ready */
          : <button type="button" className="scan-done" disabled={taken.length < (start ? 1 : 2)} onClick={onDone}>Done</button>}
      </div>

      {toast && <div className="scan-toast" role="status">{toast}</div>}
    </main>
  )
}
