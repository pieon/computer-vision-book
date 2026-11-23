import { useState, useRef } from 'react'
import { request } from '../api.js'
import { BAND, BandLine } from '../BandLine.jsx'
import { cropImage } from '../camera.js'

// Its own screen, opened by the Library after the reader (Book.jsx) closes with photos taken at decision-model turns
// and Next page taps.
// For each photo the user drags the two lines to the top and bottom of the book (same as the Scanner's setup). Confirm
// crops it there and sends it to /scan/version, which keeps it as taken (not straightened or unwarped: the tilt and
// distance are what the reading camera sees) as another fingerprint version of that page for the ORB check; Skip
// drops it. onDone after the last.
export default function CropPhotos({ id, shots, onDone }) {
  const [k, setK] = useState(0)
  const [band, setBand] = useState(BAND)
  const imgRef = useRef(null)
  const shot = shots[k]
  function next() {
    if (k + 1 < shots.length) {
      setK(k + 1)
      setBand(BAND)
      return
    }
    shots.forEach((s) => URL.revokeObjectURL(s.url))
    onDone()
  }
  function confirm() {
    const { page } = shot
    cropImage(imgRef.current, band, (blob) => {
      request(`/scan/version?${new URLSearchParams({ book: id, n: page })}`, { method: 'POST', body: blob })
        .then(({ saved, times }) => console.log(`[version] page ${page + 1} → ${saved}`, times))
        .catch((e) => console.log(`[version] page ${page + 1} failed:`, e))
    })
    next()
  }
  return (
    <div className="crop-photos" role="dialog" aria-label="Mark the book in the photo">
      <h2 className="h5">Page {shot.page + 1} ({k + 1} of {shots.length}): drag the lines to the top and bottom of the book</h2>
      <div className="crop-photos-view">
        <img ref={imgRef} src={shot.url} alt={`Camera photo of page ${shot.page + 1}`} />
        <div className="scan-shade" style={{ top: 0, height: `${band.top * 100}%` }} />
        <div className="scan-shade" style={{ top: `${band.bottom * 100}%`, bottom: 0 }} />
        <BandLine which="top" band={band} setBand={setBand} />
        <BandLine which="bottom" band={band} setBand={setBand} />
      </div>
      <div className="crop-photos-buttons">
        <button type="button" className="btn btn-outline-light" onClick={next}>Skip</button>
        <button type="button" className="btn btn-primary" onClick={confirm}>Confirm</button>
      </div>
    </div>
  )
}
