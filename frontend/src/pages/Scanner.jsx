import { useEffect, useRef, useState } from 'react'
import { remove, request } from '../api.js'

// Motion score = % of pixels whose brightness changed by more than PIXEL_T since the last frame. Sensor noise and
// light flicker move pixels only a few levels, so they don't count; that keeps "still" near 0% on any camera.
// ponytail: thresholds tuned by guess, not on many devices. Retune with the live motion % shown under the title.
const PIXEL_T = 25 // per-pixel change (0-255) that counts as real change, not noise
const MOTION_T = 10 // % of pixels changed that counts as a page turn
const STILL_T = 1 // below this % the page counts as still
const SETTLE_MS = 700 // how long it must stay still before snapping
const SMALL_W = 160 // motion is measured on a tiny copy: less noise, cheap on phones
// Digital zoom: keep the center 1/ZOOM of the frame (1 = off). Done in software since browsers
// rarely expose real camera zoom (iPad Safari doesn't). Costs resolution: 1.5 keeps ~44% of the pixels.
const ZOOM = 1.5
const TOAST_MS = 2000
// Tutorial steps (server.py saves the 1st photo as Cover, the 2nd as PageOne, ...). A step shows as done once its
// page is saved, and the next step appears when the page starts turning (motion above MOTION_T).
const STEPS = [
  { label: 'Cover', text: 'Scan the front cover of the book.' },
  { label: 'First page', text: 'Open to the first page where the story begins.' },
  { label: 'Next pages', text: 'Turn to the next page, or tap Done to finish.' },
]

// Center crop of the video frame, as drawImage source args.
function crop(video) {
  const sw = video.videoWidth / ZOOM
  const sh = video.videoHeight / ZOOM
  return [(video.videoWidth - sw) / 2, (video.videoHeight - sh) / 2, sw, sh]
}

// Full camera resolution (cropped), not the on-screen size. Hands back { blob, url }.
function snap(video, onPhoto) {
  const [sx, sy, sw, sh] = crop(video)
  const canvas = document.createElement('canvas')
  canvas.width = sw
  canvas.height = sh
  const ctx = canvas.getContext('2d')
  ctx.translate(sw, 0) // mirror left-right: undoes the reflection, so saved text reads normally
  ctx.scale(-1, 1)
  ctx.drawImage(video, sx, sy, sw, sh, 0, 0, sw, sh)
  canvas.toBlob((blob) => blob && onPhoto({ blob, url: URL.createObjectURL(blob) }), 'image/jpeg', 0.92)
}

export default function Scanner({ bookId, onDone, onCancel }) {
  const videoRef = useRef(null)
  const needTurn = useRef(false) // after a saved page, wait for a page turn before the next snap
  const [status, setStatus] = useState('Starting camera...')
  const [ready, setReady] = useState(false)
  const [photo, setPhoto] = useState(null) // the page being read; null = camera is live
  const [failed, setFailed] = useState(false)
  const [motion, setMotion] = useState(0)
  const [toast, setToast] = useState('')
  const [pages, setPages] = useState(0) // saved so far
  const saved = useRef(0) // same count, readable inside the motion loop
  const [step, setStep] = useState(0) // tutorial step shown
  const [ratio, setRatio] = useState(4 / 3) // camera frame shape, so the view box matches it exactly

  // Start the camera once; stop it when the component unmounts.
  useEffect(() => {
    let stream
    let cancelled = false
    navigator.mediaDevices
      // front camera on phones/tablets; laptops just use the webcam (not `exact`, which would fail there)
      // 4:3 matches the sensor, so nothing is cropped; ask high and the camera gives its max
      .getUserMedia({ video: { facingMode: 'user', width: { ideal: 4032 }, height: { ideal: 3024 }, aspectRatio: { ideal: 4 / 3 } }, audio: false })
      .then(async (s) => {
        stream = s
        if (cancelled) return s.getTracks().forEach((t) => t.stop())
        const video = videoRef.current
        video.srcObject = s
        await video.play()
        setStatus(`Camera ready (${video.videoWidth}×${video.videoHeight})`)
        setRatio(video.videoWidth / video.videoHeight)
        setReady(true)
      })
      // NotAllowedError = permission denied; also fails on plain http:// other than localhost
      .catch((e) => setStatus(`Camera unavailable: ${e.name}`))
    return () => {
      cancelled = true
      stream?.getTracks().forEach((t) => t.stop())
    }
  }, [])

  // Free the previous photo's memory when it's replaced.
  useEffect(() => () => photo && URL.revokeObjectURL(photo.url), [photo])

  // Every new photo goes straight to server.py, which adds it to this book's JSON.
  // Success: toast, back to the camera for the next page. Failure: red Retake.
  useEffect(() => {
    if (!photo) return
    request(`/scan?book=${bookId}`, { method: 'POST', body: photo.blob })
      .then(({ page, book }) => {
        saved.current = Object.keys(book[0].Book.Pages).length
        setPages(saved.current)
        setToast(`${page} saved`)
        setTimeout(() => setToast(''), TOAST_MS)
        needTurn.current = true
        setPhoto(null)
      })
      .catch(() => setFailed(true))
  }, [photo, bookId])

  // Cancel scanning: drop this book from the DB (JSON and page images) and leave. A page still being read is
  // finished first: the server's lock makes the delete wait for it.
  async function cancel() {
    if (pages && !window.confirm(`Discard this book and its ${pages} scanned page${pages === 1 ? '' : 's'}?`)) return
    try {
      await remove(`/books/${bookId}`) // nothing saved yet counts as done
      onCancel()
    } catch (e) {
      window.alert(`Couldn't discard the book: ${e.message}`)
    }
  }

  function retake() {
    needTurn.current = false // same page again, so snap as soon as it's steady
    setFailed(false)
    setPhoto(null)
  }

  // Auto-capture: wait for motion (page turn), then snap once it has been still for SETTLE_MS.
  // Restarts whenever the camera comes back, so the photo just taken can't count as motion.
  useEffect(() => {
    if (!ready || photo) return
    const video = videoRef.current
    const canvas = document.createElement('canvas')
    canvas.width = SMALL_W
    canvas.height = Math.round((SMALL_W * video.videoHeight) / video.videoWidth)
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    let prev = null
    let moving = !needTurn.current // first page / retake: snap once the view is steady
    let stillSince = null
    const id = setInterval(() => {
      ctx.drawImage(video, ...crop(video), 0, 0, canvas.width, canvas.height) // only what the user sees
      const cur = ctx.getImageData(0, 0, canvas.width, canvas.height).data
      if (prev) {
        let changed = 0
        for (let i = 1; i < cur.length; i += 4) if (Math.abs(cur[i] - prev[i]) > PIXEL_T) changed++ // green channel ~ gray
        const score = (changed / (cur.length / 4)) * 100
        setMotion(score)
        if (score > MOTION_T) {
          moving = true
          setStep(Math.min(saved.current, STEPS.length - 1)) // page turning: on to the next step
        }
        if (score >= STILL_T) stillSince = null
        else if (moving) {
          stillSince ??= performance.now()
          if (performance.now() - stillSince >= SETTLE_MS) {
            moving = false // need another page turn before the next snap
            snap(video, setPhoto)
          }
        }
      }
      prev = cur
    }, 100)
    return () => clearInterval(id)
  }, [ready, photo])

  const stepDone = Math.min(pages, STEPS.length - 1) > step

  return (
    // fills the screen height: header, then the camera takes what's left, so the controls are always visible
    <main className="scan" style={{ '--ratio': ratio }}>
      <header className="scan-head">
        <h1>Scanning</h1>
        <p className="scan-count"><strong>{pages}</strong> page{pages === 1 ? '' : 's'} saved</p>
      </header>
      <p className="scan-status">{status}{ready && !photo && ` · motion ${motion.toFixed(1)}%`}</p>


      <div className="scan-stage">
        <div className="scan-view">
          {/* the video stays mounted under the photo so the stream isn't lost */}
          <video ref={videoRef} autoPlay playsInline muted style={{ transform: `scale(${-ZOOM}, ${ZOOM})` }} /* mirrored, same as snap() */ />
          {photo && <img src={photo.url} alt="Captured page" />}
          {photo && <div className="scan-flash" key={photo.url} />}
          <section className="scan-guide" aria-live="polite" key={step} /* re-keyed so each step fades in */>
            <p className="scan-guide-text">{stepDone ? `✓ ${STEPS[step].label} saved. Turn the page to continue.` : STEPS[step].text}</p>
          </section>
        </div>
      </div>

      <div className="scan-controls">
        <button type="button" className="scan-cancel" onClick={cancel}>Cancel</button>
        {failed ? (
          <button type="button" className="scan-retake" onClick={retake}>Retake</button>
        ) : photo ? (
          <span className="scan-reading" role="status">
            <span className="spinner-border spinner-border-sm" aria-hidden="true" /> Reading the {pages ? 'page' : 'cover'} ...
          </span>
        ) : (
          <button type="button" className="scan-shutter" aria-label="Take picture" disabled={!ready}
            onClick={() => snap(videoRef.current, setPhoto)} />
        )}
        <button type="button" className="scan-done" onClick={onDone} disabled={pages < 2 || (!!photo && !failed)} /* needs a story page, not just the cover */>Done</button>
      </div>

      {toast && <div className="scan-toast" role="status">{toast}</div>}
    </main>
  )
}
