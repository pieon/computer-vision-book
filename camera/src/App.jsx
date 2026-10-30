import { useEffect, useRef, useState } from 'react'

export default function App() {
  const videoRef = useRef(null)
  const [status, setStatus] = useState('Starting camera...')
  const [ready, setReady] = useState(false)
  const [photoUrl, setPhotoUrl] = useState(null)

  // Start the camera once; stop it when the component unmounts.
  useEffect(() => {
    let stream
    let cancelled = false
    navigator.mediaDevices
      // rear camera on phones, falls back to the webcam on laptops
      .getUserMedia({ video: { facingMode: 'environment', width: { ideal: 3840 }, height: { ideal: 2160 } }, audio: false })
      .then(async (s) => {
        stream = s
        if (cancelled) return s.getTracks().forEach((t) => t.stop())
        const video = videoRef.current
        video.srcObject = s
        await video.play()
        setStatus(`Camera ready (${video.videoWidth}×${video.videoHeight})`)
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
  useEffect(() => () => photoUrl && URL.revokeObjectURL(photoUrl), [photoUrl])

  function takePicture() {
    const video = videoRef.current
    const canvas = document.createElement('canvas')
    canvas.width = video.videoWidth // full camera resolution, not the on-screen size
    canvas.height = video.videoHeight
    canvas.getContext('2d').drawImage(video, 0, 0)
    canvas.toBlob((blob) => setPhotoUrl(URL.createObjectURL(blob)), 'image/jpeg', 0.92)
  }

  return (
    <main>
      {/* keep the video mounted while showing a photo so the stream isn't lost */}
      <video ref={videoRef} autoPlay playsInline muted hidden={!!photoUrl} />
      {photoUrl && <img src={photoUrl} alt="Captured photo" />}

      <div className="row">
        <span className="status">{status}</span>
        {photoUrl ? (
          <>
            <a href={photoUrl} download={`photo_${Date.now()}.jpg`}>Download</a>
            <button onClick={() => setPhotoUrl(null)}>Retake</button>
          </>
        ) : (
          <button onClick={takePicture} disabled={!ready}>Take picture</button>
        )}
      </div>
    </main>
  )
}
