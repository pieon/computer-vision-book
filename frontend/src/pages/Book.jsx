import { useEffect, useRef, useState } from 'react'
import { getJson } from '../api.js'
import { startCamera } from '../camera.js'

function listen(mic) {
  let recorder
  const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/listen`)
  socket.onopen = () => {
    console.log('[stt] connected')
    recorder = new MediaRecorder(new MediaStream([mic]), { mimeType: 'audio/webm' })
    recorder.ondataavailable = (e) => { if (socket.readyState === WebSocket.OPEN) socket.send(e.data) }
    recorder.start(100) // a webm/opus chunk every 100 ms
  }
  socket.onmessage = (e) => {
    const { transcript, final } = JSON.parse(e.data)
    console.log('[stt]', final ? 'final:' : 'interim:', transcript)
  }
  socket.onclose = (e) => console.log('[stt] closed', e.code)
  return () => {
    if (recorder?.state === 'recording') recorder.stop()
    socket.close()
  }
}

// Reading view: one page's lines at a time, with the camera in a corner and the mic listening.
export default function Book({ id, onBack }) {
  const [pages, setPages] = useState(null) // [{img, text: [{Character, Dialogue}]}] in book order
  const [error, setError] = useState('')
  const [index, setIndex] = useState(0)
  const [line, setLine] = useState(0) // the line being read on this page
  const [camStatus, setCamStatus] = useState('Starting camera...')
  const videoRef = useRef(null)
  const lineRef = useRef(null) // the current line's element, to keep it in view
  const constraints = { video: { facingMode: 'user' }, audio: { echoCancellation: true, noiseSuppression: true } }
  

  useEffect(() => {
    getJson(`/books/${id}`)
      .then((book) => setPages(Object.values(book[0].Book.Pages))) // keys keep insertion order: Cover, PageOne, ...
      .catch((e) => setError(e.message))
  }, [id])
  
  // Camera + mic on while the book is open; transcripts are logged so you can see the mic working.
  useEffect(() => {
    let stopListening
    const stopCamera = startCamera(
      videoRef.current,
      // echo cancellation keeps sound from the speakers (e.g. read-aloud audio) out of the transcript
      constraints,
      (s) => { setCamStatus(''), stopListening = listen(s.getAudioTracks()[0]) },
      (e) => { setCamStatus(`Camera/mic unavailable: ${e.name}`); console.log('[mic] failed:', e) },
    )
    return () => {
      stopListening?.()
      stopCamera()
    }
  }, [])

  const page = pages?.[index]
  const current = page?.text[line]
  const lastLine = !page || line >= page.text.length - 1 // also true on a page with no text
  const atEnd = pages && index === pages.length - 1 && lastLine

  // Next: the page's next line, or the first line of the next page.
  function next() {
    if (!lastLine) return setLine(line + 1)
    setIndex(index + 1)
    setLine(0)
  }

  // A Narrator line is read aloud when it becomes current (backend caches each clip, routes/tts.py);
  // character lines are left for the reader. Moving on stops the clip.
  useEffect(() => {
    if (current?.Character !== 'Narrator') return
    const audio = new Audio(`/tts?text=${encodeURIComponent(current.Dialogue)}`)
    // AbortError = paused before it started (Next pressed while loading); expected, not a failure
    audio.play().catch((e) => { if (e.name !== 'AbortError') console.log('[tts] play failed:', e) })
    return () => audio.pause()
  }, [current])

  // braces: smooth scrollIntoView returns a Promise in newer browsers, and an effect may only return a cleanup function
  useEffect(() => { lineRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }) }, [current])

  return (
    <div className="reader">
      <div className="d-flex align-items-center mb-3">
        <h1 className="h3 me-auto mb-0">Page {index + 1}</h1>
        <button type="button" className="btn btn-outline-light" onClick={onBack}>Back</button>
      </div>

      {error && <div className="alert alert-danger">Couldn't load book: {error}</div>}
      {!error && !pages && <p>Loading...</p>}
      {page && (
        <div className="reader-text">
          {page.text.length ? page.text.map((l, i) => (
            <div key={i} ref={i === line ? lineRef : null}
              className={`reader-line${l.Character === 'Narrator' ? ' reader-narrator' : ''}${i === line ? ' reader-current' : ''}`}>
              <span className="reader-speaker">{l.Character}</span>
              <p>{l.Dialogue}</p>
            </div>
          )) : <p className="text-secondary">(No text on this page)</p>}
        </div>
      )}
      {pages && !atEnd && (
        <button type="button" className="btn btn-primary" onClick={next}>Next</button>
      )}

      <div className="reader-cam">
        <video ref={videoRef} autoPlay playsInline muted />
        {camStatus && <span>{camStatus}</span>}
      </div>
    </div>
  )
}
