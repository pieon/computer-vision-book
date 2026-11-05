import { useEffect, useRef, useState } from 'react'
import { remove, request } from '../api.js'
import { snap, startCamera, watchMotion } from '../camera.js'

const STEPS = [
  { label: 'Cover', text: 'Scan the front cover of the book.' },
  { label: 'First page', text: 'Open to the first page where the story begins.' },
  { label: 'Next pages', text: 'Turn to the next page, or tap Done to finish.' },
]

export default function Scanner({ bookId, onDone, onCancel }) {
  const videoRef = useRef(null)
  const needTurn = useRef(false) 
  const [status, setStatus] = useState('Starting camera...')
  const [ready, setReady] = useState(false)
  const [photo, setPhoto] = useState(null) // the page being read; null = camera is live
  const [failed, setFailed] = useState(false)
  const [motion, setMotion] = useState(0)
  const [toast, setToast] = useState('')
  const [pages, setPages] = useState(0) 
  const saved = useRef(0) 
  const [step, setStep] = useState(0) 
  const [ratio, setRatio] = useState(4 / 3) 

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

  // Free the previous photo's memory when it's replaced.
  useEffect(() => () => photo && URL.revokeObjectURL(photo.url), [photo])

  // Every new photo goes straight to server.py, which adds it to this book's JSON.
  useEffect(() => {
    if (!photo) return
    request(`/scan?book=${bookId}`, { method: 'POST', body: photo.blob })
      .then(({ page, book }) => {
        saved.current = Object.keys(book[0].Book.Pages).length
        setPages(saved.current)
        setToast(`${page} saved`)
        setTimeout(() => setToast(''), 2000)
        needTurn.current = true
        setPhoto(null)
      })
      .catch(() => setFailed(true))
  }, [photo, bookId])

  // Cancel scanning: drop this book from the DB (JSON and page images) and leave. A page still being read is
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

  // Auto-capture: wait for motion (page turn), then snap once it has been still for 700ms.
  useEffect(() => {
    if (!ready || photo) return
    const video = videoRef.current
    let moving = !needTurn.current
    let stillSince = null
    return watchMotion(video, (score) => {
      setMotion(score)
      if (score > 10) {
        moving = true
        setStep(Math.min(saved.current, STEPS.length - 1))
      }
      if (score >= 8) stillSince = null
      else if (moving) {
        stillSince ??= performance.now()
        if (performance.now() - stillSince >= 300) {
          moving = false
          snap(video, setPhoto)
        }
      }
    })
  }, [ready, photo])

  const stepDone = Math.min(pages, STEPS.length - 1) > step

  return (
    <main className="scan" style={{ '--ratio': ratio }}>
      <header className="scan-head">
        <h1>Scanning</h1>
        <p className="scan-count"><strong>{pages}</strong> page{pages === 1 ? '' : 's'} saved</p>
      </header>
      <p className="scan-status">{status}{ready && !photo && ` · motion ${motion.toFixed(1)}%`}</p>


      <div className="scan-stage">
        <div className="scan-view">
          <video ref={videoRef} autoPlay playsInline muted style={{ transform: `scale(-1.5, 1.5)` }} /* mirrored, same as snap() */ />
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
        <button type="button" className="scan-done" onClick={onDone} disabled={pages < 2 || (!!photo && !failed)} >Done</button>
      </div>

      {toast && <div className="scan-toast" role="status">{toast}</div>}
    </main>
  )
}
