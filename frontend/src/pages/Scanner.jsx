import { useEffect, useRef, useState } from 'react'
import { remove, timing } from '../api.js'
import { CORNERS, CornerDots, cornersBand } from '../CornerDots.jsx'
import { FULL, snap, startCamera, watchMotion } from '../camera.js'
import { cancel as cancelUploads, enqueue } from '../scanQueue.js'
import { requestTurn, watchTurn } from '../tilt.js'

const SETTLE_MS = 2000 // still this long before the photo
// Motion % per camera: above `turn` = turning, below `still` = still
// ponytail: back levels are a guess; tune from the status line
const MOTION = { front: { turn: 12, still: 8 }, back: { turn: 30, still: 22 } }
const STEPS = [ // next step, by photos taken
  'Scan the front cover of the book.',
  'Open to the first page where the story begins.',
  'Turn to the next page, or tap Done to finish.',
]

// Which camera scans, kept per device (front: mark corners; back: full frame)
const loadFacing = () => { try { return localStorage.getItem('scanCamera') === 'back' ? 'back' : 'front' } catch { return 'front' } }
const saveFacing = (f) => { try { localStorage.setItem('scanCamera', f) } catch { /* private mode: not remembered */ } }

// start: first page position (0 = new book). Front: photos cut to the marked corners; back: full frame, turned upright.
export default function Scanner({ bookId, start = 0, onDone, onCancel }) {
  const videoRef = useRef(null)
  const needTurn = useRef(false) // wait for the next turn
  const [status, setStatus] = useState('Starting camera...')
  const [ready, setReady] = useState(false)
  const [motion, setMotion] = useState(0)
  const [toast, setToast] = useState('')
  const [taken, setTaken] = useState([]) // photo labels
  const [ratio, setRatio] = useState(4 / 3)
  const [phase, setPhase] = useState('setup') // 'setup' | 'scan'
  const [facing, setFacing] = useState(loadFacing) // 'front' | 'back'
  const front = facing === 'front'
  const [corners, setCorners] = useState(CORNERS) // frame fractions (front only)
  const band = front ? cornersBand(corners) : FULL // rows the photo is cut to
  // corners in the cut photo, for /scan
  const inBand = front ? corners.flatMap((c) => [c.x, (c.y - band.top) / (band.bottom - band.top || 1)]) : null
  // back camera: clockwise turn to keep the book upright; null = motion refused
  const [turn, setTurn] = useState(0)
  const turnRef = useRef(0)

  // iOS motion access needs a tap
  const askTurn = () => requestTurn().then((ok) => { if (!ok) setTurn(null) })
  useEffect(() => {
    if (front) return
    return watchTurn((t) => { turnRef.current = t; setTurn(t) })
  }, [front])

  function pickCamera(f) {
    if (f !== 'front') askTurn()
    if (f === facing) return
    saveFacing(f)
    setFacing(f)
    setReady(false)
    setStatus('Starting camera...')
  }

  // Start the chosen camera; track the frame shape (it changes on rotation)
  useEffect(() => {
    const video = videoRef.current
    const onResize = () => {
      if (!video.videoWidth) return
      setRatio(video.videoWidth / video.videoHeight)
      setStatus(`Camera ready (${video.videoWidth}×${video.videoHeight})`)
    }
    video.addEventListener('resize', onResize)
    const stop = startCamera(
      video,
      { video: { facingMode: front ? 'user' : 'environment', width: { ideal: 4032 }, height: { ideal: 3024 }, aspectRatio: { ideal: 4 / 3 } }, audio: false },
      () => {
        onResize()
        setReady(true)
      },
      (e) => setStatus(`Camera unavailable: ${e.name}`),
    )
    return () => {
      video.removeEventListener('resize', onResize)
      stop()
    }
  }, [front])

  // Photos upload in the background (scanQueue.js)
  const count = useRef(start) // next page position
  function add(photo, t, cut) {
    URL.revokeObjectURL(photo.url)
    const i = count.current++
    const label = i ? `Page ${i}` : 'Cover'
    setTaken((list) => [...list, label])
    setToast(`${label} taken`)
    setTimeout(() => setToast(''), 1500)
    const takenAt = performance.now()
    enqueue(bookId, i, photo.blob, (reply, err, sentAt) => {
      // queued = waiting for an upload slot
      if (reply) {
        console.log('[scan]', label, `-> ${reply.page} (${Math.round(photo.blob.size / 1024)} KB) |`,
          timing({ ...t, queued: sentAt - takenAt }, reply.times, performance.now() - sentAt))
      } else console.log('[scan]', label, 'failed twice:', err)
    }, cut)
  }

  // Cancel: leave now and delete a new book in the background; adding pages just stops
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

  // Auto-capture: after a page turn, snap once still for SETTLE_MS
  useEffect(() => {
    if (!ready || phase !== 'scan') return
    const { turn: turning, still } = MOTION[facing]
    const video = videoRef.current
    let moving = !needTurn.current
    let movedAt = moving ? performance.now() : null // for stage times
    let stillSince = null
    return watchMotion(video, (score) => {
      setMotion(score)
      if (score > turning) {
        movedAt ??= performance.now()
        moving = true
      }
      if (score >= still) stillSince = null
      else if (moving) {
        stillSince ??= performance.now()
        if (performance.now() - stillSince >= SETTLE_MS) {
          moving = false
          needTurn.current = true
          const snapAt = performance.now()
          // flip / settle / snap times
          const t = { flip: stillSince - movedAt, settle: snapAt - stillSince }
          movedAt = null
          snap(video, (p) => add(p, { ...t, snap: performance.now() - snapAt }, inBand),
            { band, mirror: front, turn: front ? 0 : turnRef.current })
        }
      }
    }, band)
  }, [ready, phase, ratio]) // eslint-disable-line react-hooks/exhaustive-deps

  const last = taken.at(-1)
  const setup = phase === 'setup'
  const guide = setup
    ? front ? 'Open the book and drag the four dots to its corners, then tap Confirm.'
      : 'Hold the iPad over the open book so it fills the view, then tap Confirm.'
    : `${last ? `✓ ${last} taken. ` : ''}${start && !taken.length ? 'Open to the page you want to add.' : STEPS[Math.min(start + taken.length, STEPS.length - 1)]}`

  return (
    <main className="scan" style={{ '--ratio': ratio }}>
      <header className="scan-head">
        <h1>{start ? 'Adding pages' : 'Scanning'}</h1>
      </header>
      <p className="scan-status">{status}{ready && !setup && ` · motion ${motion.toFixed(1)}%`}
        {!front && (turn === null ? ' · no motion access: photos not turned' : turn ? ` · photos turned ${turn}°` : '')}</p>

      <div className="scan-stage">
        <div className="scan-view">
          <video ref={videoRef} className={front ? '' : 'unmirrored'} autoPlay playsInline muted />
          {/* darkened outside the corners */}
          {ready && front && <CornerDots corners={corners} setCorners={setCorners} fixed={!setup} />}
          {taken.length > 0 && <div className="scan-flash" key={`flash${taken.length}`} />}
          <section className="scan-guide" aria-live="polite" key={`${phase}${taken.length}`} /* re-keyed to fade in */>
            <p className="scan-guide-text">{guide}</p>
          </section>
        </div>
      </div>

      <div className="scan-controls">
        <button type="button" className="scan-cancel" onClick={cancel}>Cancel</button>
        {/* camera can change only before scanning */}
        {setup ? (
          <div className="scan-camera" role="group" aria-label="Camera">
            {[['front', 'Front'], ['back', 'Back']].map(([f, name]) => (
              <button type="button" key={f} aria-pressed={facing === f} onClick={() => pickCamera(f)}>{name}</button>
            ))}
          </div>
        ) : <div />}
        {setup
          ? <button type="button" className="scan-done" disabled={!ready} onClick={() => { if (!front) askTurn(); setPhase('scan') }}>Confirm</button>
          /* processing carries on in the background */
          : <button type="button" className="scan-done" disabled={taken.length < (start ? 1 : 2)} onClick={onDone}>Done</button>}
      </div>

      {toast && <div className="scan-toast" role="status">{toast}</div>}
    </main>
  )
}
