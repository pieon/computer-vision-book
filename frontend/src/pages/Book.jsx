import { useEffect, useRef, useState } from 'react'
import { getJson } from '../api.js'

const VOICE_LEVEL = 0.02 // RMS above this counts as voice; ponytail: fixed threshold, calibrate per mic/room if it misfires

// Reading view: one page's lines at a time, with the camera in a corner and the mic listening.
export default function Book({ id, onBack }) {
  const [pages, setPages] = useState(null) // [{img, text: [{Character, Dialogue}]}] in book order
  const [error, setError] = useState('')
  const [index, setIndex] = useState(0)
  const [camStatus, setCamStatus] = useState('Starting camera...')
  const videoRef = useRef(null)

  useEffect(() => {
    getJson(`/books/${id}`)
      .then((book) => setPages(Object.values(book[0].Book.Pages))) // keys keep insertion order: Cover, PageOne, ...
      .catch((e) => setError(e.message))
  }, [id])

  // Camera + mic on while the book is open; the mic level is logged so you can see it working.
  useEffect(() => {
    let stream, audio, timer, socket, recorder
    let cancelled = false
    navigator.mediaDevices
      // echo cancellation keeps sound from the speakers (e.g. read-aloud audio) out of the transcript
      .getUserMedia({ video: { facingMode: 'user' }, audio: { echoCancellation: true, noiseSuppression: true } })
      .then(async (s) => {
        stream = s
        if (cancelled) return s.getTracks().forEach((t) => t.stop())
        const video = videoRef.current
        video.srcObject = s
        await video.play()
        setCamStatus('')
        const mic = s.getAudioTracks()[0]

        // mic -> backend (routes/listen.py) -> Deepgram; transcripts come back on the same socket
        socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/listen`)
        socket.onopen = () => {
          console.log('[stt] connected')
          recorder = new MediaRecorder(new MediaStream([mic]), { mimeType: 'audio/webm' }) 
          recorder.ondataavailable = (e) => {
            if (socket.readyState === WebSocket.OPEN) {
              socket.send(e.data)
            }
          }
          recorder.start(100) // a webm/opus chunk every 100 ms
        }
        socket.onmessage = (e) => {
          const { transcript, final } = JSON.parse(e.data)
          console.log('[stt]', final ? 'final:' : 'interim:', transcript)
        }
        socket.onclose = (e) => console.log('[stt] closed', e.code)
      })
      .catch((e) => { setCamStatus(`Camera/mic unavailable: ${e.name}`); console.log('[mic] failed:', e) })
    return () => {
      cancelled = true
      clearInterval(timer)
      audio?.close()
      if (recorder?.state === 'recording') recorder.stop()
      socket?.close()
      stream?.getTracks().forEach((t) => t.stop())
    }
  }, [])

  const page = pages?.[index]

  // Read the page's Narrator lines aloud, one after another (backend caches each clip, routes/tts.py).
  // Character lines are left for the reader. Turning the page stops the current line.
  useEffect(() => {
    if (!page) return
    let stopped = false
    let audio
    ;(async () => {
      for (const l of page.text) {
        if (stopped) return
        if (l.Character !== 'Narrator') continue
        audio = new Audio(`/tts?text=${encodeURIComponent(l.Dialogue)}`)
        await new Promise((done) => {
          audio.onended = audio.onerror = done
          audio.play().catch((e) => { console.log('[tts] play failed:', e); done() })
        })
      }
    })()
    return () => { stopped = true; audio?.pause() }
  }, [page])

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
            <div key={i} className={`reader-line${l.Character === 'Narrator' ? ' reader-narrator' : ''}`}>
              <span className="reader-speaker">{l.Character}</span>
              <p>{l.Dialogue}</p>
            </div>
          )) : <p className="text-secondary">(No text on this page)</p>}
        </div>
      )}
      {pages && index < pages.length - 1 && (
        <button type="button" className="btn btn-primary" onClick={() => setIndex((i) => i + 1)}>Next</button>
      )}

      <div className="reader-cam">
        <video ref={videoRef} autoPlay playsInline muted />
        {camStatus && <span>{camStatus}</span>}
      </div>
    </div>
  )
}
