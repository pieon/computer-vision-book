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
    let stream, audio, timer
    let cancelled = false
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: 'user' }, audio: true })
      .then(async (s) => {
        stream = s
        if (cancelled) return s.getTracks().forEach((t) => t.stop())
        const video = videoRef.current
        video.srcObject = s
        await video.play()
        setCamStatus('')
        const mic = s.getAudioTracks()[0]
        
      })
      .catch((e) => { setCamStatus(`Camera/mic unavailable: ${e.name}`); console.log('[mic] failed:', e) })
    return () => {
      cancelled = true
      clearInterval(timer)
      audio?.close()
      stream?.getTracks().forEach((t) => t.stop())
    }
  }, [])

  const page = pages?.[index]
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
          {page.text.length ? page.text.map((l, i) => <p key={i}>{l.Dialogue}</p>) : <p className="text-secondary">(No text on this page)</p>}
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
