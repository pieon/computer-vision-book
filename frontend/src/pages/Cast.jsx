import { useEffect, useState } from 'react'
import { getJson, ttsUrl } from '../api.js'
import { PlayIcon } from '../components/icons.jsx'
import { narrator, unlock } from '../narrator.js'

// CA's mates (CA/src/Book/Roles.js): a Gemini prebuilt voice each, and a color for its dot
const VOICES = [
  { name: 'Orange Opal', voice: 'Aoede', color: '#ff9f43' },
  { name: 'Green Grant', voice: 'Umbriel', color: '#2ecc71' },
  { name: 'Yellow Yancey', voice: 'Puck', color: '#f1c40f' },
  { name: 'Violet Victor', voice: 'Enceladus', color: '#9b59b6' },
  { name: 'Blue Beatrice', voice: 'Zephyr', color: '#3498db' },
  { name: 'Ruby Randy', voice: 'Iapetus', color: '#e74c3c' },
  { name: 'Coral Carly', voice: 'Kore', color: '#ff7f6e' },
]

// Before each reading: who reads each character. A voice = the app speaks that character's lines;
// '' = the reader reads them (tracked by the mic). Not saved; Start hands the choice to the reader page.
export default function Cast({ id, onStart, onBack }) {
  const [cast, setCast] = useState(null) // { character: voice | '' }
  const [error, setError] = useState('')

  useEffect(() => {
    getJson(`/books/${id}`)
      .then((book) => setCast(Object.fromEntries(book[0].Book.Characters.map((c) => [c.Name, ['Narrator', 'Onomatopoeia'].includes(c.Name) ? 'Aoede' : '']))))
      .catch((e) => setError(e.message))
  }, [id])

  function preview(name) {
    narrator.onended = narrator.onerror = null
    narrator.src = ttsUrl(`Hi, I'm ${name}.`, cast[name])
    narrator.play().catch((e) => { if (e.name !== 'AbortError') console.log('[tts] preview failed:', e) })
  }

  return (
    <div className="container py-3 editor cast">
      <div className="d-flex align-items-center gap-2 mb-3">
        <button type="button" className="btn btn-outline-light" onClick={onBack}>Back</button>
        <h1 className="h3 mb-0 me-auto">Who reads?</h1>
        <button type="button" className="btn btn-primary" disabled={!cast}
          onClick={() => { narrator.pause(); unlock(); onStart(cast) }} /* unlock: Safari plays narration only after a tap */>Start</button>
      </div>
      {error && <div className="alert alert-danger">Couldn't load book: {error}</div>}
      {!error && !cast && <p>Loading...</p>}
      {cast && Object.entries(cast).map(([name, voice]) => (
        <div className="cast-row" key={name}>
          <span className="cast-dot" style={{ background: VOICES.find((v) => v.voice === voice)?.color ?? 'transparent' }} />
          <label className="cast-name" htmlFor={`cast-${name}`}>{name}</label>
          <select id={`cast-${name}`} className="form-select" value={voice}
            onChange={(e) => setCast({ ...cast, [name]: e.target.value })}>
            <option value="">Reader (me)</option>
            {VOICES.map((v) => <option key={v.voice} value={v.voice}>{v.name}</option>)}
          </select>
          <button type="button" className="cast-play" aria-label={`Hear ${name}'s voice`}
            style={{ visibility: voice ? 'visible' : 'hidden' }} onClick={() => preview(name)}>{PlayIcon}</button>
        </div>
      ))}
    </div>
  )
}
