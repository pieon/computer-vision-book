import { useEffect, useRef, useState } from 'react'
import { getJson, ttsUrl } from '../api.js'
import Cropper from '../components/Cropper.jsx'
import { PersonSilhouette, PlayIcon } from '../components/icons.jsx'
import { narrator, unlock } from '../narrator.js'
import { unlockSounds } from '../sounds.js'
import { Orb, orbOf, orbStyle, READER, VOICES } from '../components/Orb.jsx'

const DEFAULTS = { Narrator: 'Aoede' }
// Default voices: the Narrator's, then unused ones; extras start empty (the reader)
function autoCast(names) {
  const free = VOICES.map((v) => v.voice).filter((v) => !names.some((n) => DEFAULTS[n] === v))
  return Object.fromEntries(names.map((n) => [n, DEFAULTS[n] ?? free.shift() ?? '']))
}
const RING_ORB = 80 // px, voice orbs
const STEP = 116 // px per ring slot (and per swipe)

// Fly a copy of an orb between two elements
function fly(fromRect, toRect, orb) {
  if (!fromRect || !toRect || matchMedia('(prefers-reduced-motion: reduce)').matches) return Promise.resolve()
  const size = RING_ORB
  const el = document.createElement('span')
  el.className = `cast-orb cast-orb-flying${orb === READER ? ' cast-orb-reader' : ''}`
  el.style.cssText = `${orbStyle(orb, size)};left:0;top:0`
  document.body.append(el)
  const at = (r) => `translate(${r.left + r.width / 2 - size / 2}px, ${r.top + r.height / 2 - size / 2}px)`
  return el.animate([{ transform: at(fromRect) }, { transform: at(toRect) }],
    { duration: 380, easing: 'cubic-bezier(.2,.8,.2,1)' }).finished.finally(() => el.remove())
}

// Before reading: a voice for each character. Start hands { character: voice | '' } ('' = the reader).
export default function Cast({ id, onStart, onBack }) {
  const [boxes, setBoxes] = useState(null) // { character: voice | 'reader' | '' }
  const [firstImg, setFirstImg] = useState({}) // first page they speak on
  const [faces, setFaces] = useState({}) // cropped picture
  const [pageImgs, setPageImgs] = useState([]) // for the cropper
  const [cropping, setCropping] = useState(null)
  const [error, setError] = useState('')
  const [picked, setPicked] = useState(null) // { orb: voice key } | { row: character } | null
  const [hidden, setHidden] = useState(new Set()) // hidden while a copy flies there
  const [rot, setRot] = useState(0) // ring position in slots
  const [dragging, setDragging] = useState(false)
  const boxRefs = useRef({})
  const orbRefs = useRef({})
  const ringRef = useRef(null)
  const moved = useRef(false) // last pointer down was a swipe

  useEffect(() => {
    getJson(`/books/${id}`)
      .then((book) => {
        const { Characters, Pages } = book[0].Book
        const first = {}
        for (const p of Object.values(Pages)) for (const l of p.text) first[l.Character] ??= p.img
        setFirstImg(first)
        setPageImgs(Object.values(Pages).map((p) => p.img))
        setFaces(Object.fromEntries(Characters.filter((c) => c.img).map((c) => [c.Name, c.img])))
        setBoxes(autoCast(Characters.map((c) => c.Name).filter((n) => n !== 'Onomatopoeia'))) // no row: see start()
      })
      .catch((e) => setError(e.message))
  }, [id])

  const placed = new Set(Object.values(boxes ?? {}))
  const ring = [READER, ...VOICES.filter((v) => !placed.has(v.voice))]
  const n = ring.length
  useEffect(() => { setRot((r) => ((Math.round(r) % n) + n) % n) }, [n]) // orb count changed

  const hide = (key, on) => setHidden((h) => { const c = new Set(h); if (on) c.add(key); else c.delete(key); return c })
  const rectOf = (el) => el?.getBoundingClientRect()

  function preview(voice, name) {
    narrator.onended = narrator.onerror = null
    narrator.src = ttsUrl(`Hi, I'm ${name}.`, voice)
    narrator.play().catch((e) => { if (e.name !== 'AbortError') console.log('[tts] preview failed:', e) })
  }

  // Put orb `key` in `name`'s box, swapping out any voice there
  function place(name, key) {
    const old = boxes[name]
    setPicked(null)
    if (old === key) return
    const from = rectOf(orbRefs.current[key])
    const to = rectOf(boxRefs.current[name])
    const ringCenter = rectOf(ringRef.current?.querySelector('.cast-ring-center'))
    setBoxes((b) => ({ ...b, [name]: key }))
    hide(`box:${name}`, true)
    fly(from, to, orbOf(key)).then(() => hide(`box:${name}`, false))
    if (old && old !== READER.voice) {
      hide(`ring:${old}`, true)
      fly(to, ringCenter, orbOf(old)).then(() => hide(`ring:${old}`, false))
    }
  }

  // Empty a box; its voice flies back to the ring.
  function sendBack(name) {
    const old = boxes[name]
    const from = rectOf(boxRefs.current[name])
    const ringCenter = rectOf(ringRef.current?.querySelector('.cast-ring-center'))
    setBoxes((b) => ({ ...b, [name]: '' }))
    if (old === READER.voice) return
    hide(`ring:${old}`, true)
    fly(from, ringCenter, orbOf(old)).then(() => hide(`ring:${old}`, false))
  }

  function tapBox(name) {
    if (picked?.orb) return place(name, picked.orb)
    if (boxes[name]) return sendBack(name)
    setPicked(picked?.row === name ? null : { row: name })
  }

  function tapOrb(orb, d) {
    if (moved.current) return // end of a swipe
    setRot((r) => r + d) // bring it to the center
    if (picked?.row) return place(picked.row, orb.voice)
    if (picked?.orb === orb.voice) return setPicked(null)
    setPicked({ orb: orb.voice })
    if (orb !== READER) preview(orb.voice, orb.name)
  }

  // Swipe: drag the ring sideways; on release it snaps to the nearest slot.
  function onPointerDown(e) {
    const x0 = e.clientX
    const r0 = rot
    moved.current = false
    const move = (ev) => {
      const dx = ev.clientX - x0
      if (Math.abs(dx) > 6) { moved.current = true; setDragging(true) }
      if (moved.current) setRot(r0 - dx / STEP)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      setDragging(false)
      setRot((r) => Math.round(r))
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const start = () => {
    narrator.pause()
    unlock() // Safari plays narration only after a tap
    unlockSounds() // and sound effects
    const cast = Object.fromEntries(Object.entries(boxes).map(([name, v]) => [name, v === READER.voice ? '' : v]))
    onStart({ ...cast, Onomatopoeia: cast.Narrator }) // Onomatopoeia follows the Narrator
  }

  return (
    <div className="container py-3 cast">
      <div className="d-flex align-items-center gap-2 mb-3">
        <button type="button" className="btn btn-outline-light" onClick={onBack}>Back</button>
        <h1 className="h3 mb-0 me-auto">Who reads?</h1>
        <button type="button" className="btn btn-primary" disabled={!boxes} onClick={start}>Start</button>
      </div>
      {error && <div className="alert alert-danger">Couldn't load book: {error}</div>}
      {!error && !boxes && <p>Loading...</p>}

      {/* one card per character */}
      {boxes && <div className="cast-cards">{Object.entries(boxes).map(([name, key]) => {
        const orb = key && orbOf(key)
        return (
          <div className={`cast-card${picked?.row === name ? ' picked' : ''}`} key={name}>
            {name === 'Narrator' // no picture
              ? <span className="cast-face"><PersonSilhouette className="cast-page cast-silhouette" /><span className="cast-name">{name}</span></span>
              : <button type="button" className="cast-face" onClick={() => setCropping(name)}
                aria-label={faces[name] ? `${name}'s picture. Tap to crop again` : `Crop a picture of ${name}`}>
                {faces[name] || firstImg[name]
                  ? <img className="cast-page" src={`/images/${id}/${faces[name] || firstImg[name]}`} alt="" loading="lazy" />
                  : <span className="cast-page" />}
                <span className="cast-name">{name}</span>
                <span className="cast-face-badge" aria-hidden="true">{faces[name] ? '✎' : '✂'}</span>
              </button>}
            {/* the whole side is the target */}
            <div className="cast-voice" onClick={() => tapBox(name)}>
              <button type="button" ref={(el) => { boxRefs.current[name] = el }} className={`cast-box${orb ? ' filled' : ''}${picked?.orb ? ' ready' : ''}`}
                aria-label={orb ? `${name}: ${orb.name}. Tap to ${picked?.orb ? 'swap' : 'remove'}` : `${name}: empty (Reader). Tap to place a voice`}>
                {orb && !hidden.has(`box:${name}`) && <Orb orb={orb} size={RING_ORB} label={false} />}
              </button>
              <span className="cast-box-name">{orb ? orb.name : 'Reader'}</span>
              <button type="button" className="cast-play" aria-label={`Hear ${name}'s voice`}
                style={{ visibility: orb && orb !== READER ? 'visible' : 'hidden' }}
                onClick={(e) => { e.stopPropagation(); preview(key, orb.name) }}>{PlayIcon}</button>
            </div>
          </div>
        )
      })}</div>}
      {boxes && <p className="cast-hint">Tap a voice, then a character's circle. Empty circles are read by you.</p>}

      {boxes && (
        <div className="cast-ring" ref={ringRef} onPointerDown={onPointerDown}>
          <button type="button" className="cast-ring-arrow left" aria-label="Previous voice" onClick={() => setRot((r) => r - 1)}>‹</button>
          <span className="cast-ring-center" aria-hidden="true" />
          {ring.map((orb, i) => {
            let d = (((i - rot) % n) + n) % n
            if (d > n / 2) d -= n
            const a = Math.min(Math.abs(d), 3)
            return (
              <button type="button" key={orb.voice} ref={(el) => { orbRefs.current[orb.voice] = el }}
                className={`cast-ring-item${picked?.orb === orb.voice ? ' picked' : ''}${dragging ? ' dragging' : ''}`}
                style={{ transform: `translateX(calc(-50% + ${d * STEP}px)) scale(${1 - a * 0.18})`, opacity: 1 - a * 0.28,
                  zIndex: 10 - Math.round(a), visibility: hidden.has(`ring:${orb.voice}`) || Math.abs(d) > 3 ? 'hidden' : 'visible' }}
                aria-pressed={picked?.orb === orb.voice} onClick={() => tapOrb(orb, d)}>
                <Orb orb={orb} size={RING_ORB} />
              </button>
            )
          })}
          <button type="button" className="cast-ring-arrow right" aria-label="Next voice" onClick={() => setRot((r) => r + 1)}>›</button>
        </div>
      )}
      {cropping && (
        <Cropper id={id} name={cropping} pages={pageImgs} start={firstImg[cropping]}
          onCancel={() => setCropping(null)}
          onDone={(img) => { setFaces((f) => ({ ...f, [cropping]: img })); setCropping(null) }} />
      )}
    </div>
  )
}
