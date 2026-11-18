import { useEffect, useRef, useState } from 'react'
import { getJson, request, timing, ttsUrl } from '../api.js'
import { frameSheet, snap, startCamera, watchMotion } from '../camera.js'
import { FlagIcon, MicIcon, NextIcon, NextPageIcon, PauseIcon, PlayIcon, PrevIcon, PrevPageIcon } from '../components/icons.jsx'
import { narrator } from '../narrator.js'
import BookEditor from './BookEditor.jsx'
import { isRead, variants, words } from '../reading.js'

// Connect to deepgram and stream the mic input to the deepgram api. Disconnect mic stream upon closing.
function listen(mic, reading, book, onText) {
  let recorder
  const query = new URLSearchParams({ reading, book }) // book: the backend logs this session's minutes for the Home chart
  const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/listen?${query}`)
  socket.onopen = () => {
    console.log('[stt] connected')
    recorder = new MediaRecorder(new MediaStream([mic]), { mimeType: 'audio/webm' })
    let sending = Promise.resolve()
    recorder.ondataavailable = (e) => {
      sending = sending
        .then(() => e.data.arrayBuffer())
        .then((bytes) => { if (socket.readyState === WebSocket.OPEN) socket.send(bytes) })
        .catch((err) => console.log('[stt] chunk failed:', err))
    }
    recorder.start(100) // a webm/opus chunk every 100 ms
  }
  socket.onmessage = (e) => {
    const { transcript, final } = JSON.parse(e.data)
    console.log('[stt]', final ? 'final:' : 'interim:', transcript)
    onText(transcript, final)
  }
  socket.onclose = (e) => console.log('[stt] closed', e.code)
  return () => {
    if (recorder?.state === 'recording') recorder.stop()
    socket.close()
  }
}

// Decide between 'orb' or 'decision'
const TURN_CHECK = 'orb'
// Save 10 frames of image if the motion score goes over SHEET_MOTION
const SAVE_SHEETS = true
// Indicator to take picture
const SHEET_MOTION = 8

// Console badges for the page-turn checks (filter "ORB" / "DECISION")
const BADGE = {
  orb: 'background:#1e6fd9;color:#fff;font-weight:bold;border-radius:3px',
  decision: 'background:#e67e22;color:#fff;font-weight:bold;border-radius:3px',
  sheet: 'background:#8e44ad;color:#fff;font-weight:bold;border-radius:3px',
  yes: 'color:#27ae60;font-weight:bold', // turned / moving
  no: 'color:inherit',
  err: 'color:#e74c3c;font-weight:bold',
}

// ponytail: one request in flight at a time, nonstop while waiting; add a short gap if the server load matters
const TURN_CHECKS = {
  orb(video, query, page, goTo) {
    let stopped = false
    const check = () => snap(video, ({ blob, url }) => {
      URL.revokeObjectURL(url)
      const sentAt = performance.now()
      request(`/turn?${query}`, { method: 'POST', body: blob })
        .then(({ page: p, scores, times }) => {
          const inliers = Object.entries(scores).map(([k, v]) => `p${+k + 1} ${v}`).join(', ')
          console.log(`%c ORB %c page ${page + 1} → ${p !== page ? `TURNED to page ${p + 1}` : 'same page'}`
            + ` · inliers ${inliers} (25 to turn)${stopped ? ' · (after turn)' : ''}`, BADGE.orb, p !== page ? BADGE.yes : BADGE.no,
          `| ${Math.round(blob.size / 1024)} KB |`, timing({}, times, performance.now() - sentAt))
          if (!stopped && p !== page) goTo(p)
        })
        .catch((e) => console.log('%c ORB %c failed', BADGE.orb, BADGE.err, e))
        .finally(() => { if (!stopped) check() })
    }, { maxWidth: 1400, quality: 0.8, zoom: 1 }) // full frame: unwarp finds the page wherever the book sits
    check()
    return () => { stopped = true }
  },

  // a sheet done while a request is in flight is dropped
  // ponytail: any "moving" turns, whatever its p; add a cutoff (e.g. p >= 0.8) if it turns too early
  decision(video, query, page, goTo) {
    let stopped = false
    let deciding = false
    let stopSheet = () => {}
    const sheet = () => {
      stopSheet = frameSheet(video, ({ blob, ms }) => {
        if (!stopped) sheet() // start the next sheet right away
        if (deciding) return
        deciding = true
        const sentAt = performance.now()
        request(`/turn/decide?${query}`, { method: 'POST', body: blob })
          .then(({ moving, p, error, saved, times }) => {
            const answer = error ? `error ${error}` : moving ? `MOVING (p ${p}) → page ${page + 2}` : `still (p ${p})`
            console.log(`%c DECISION %c page ${page + 1} · ${answer}${stopped ? ' · (after turn)' : ''}`,
              BADGE.decision, error ? BADGE.err : moving ? BADGE.yes : BADGE.no,
              `| ${saved} |`, timing({ capture: ms }, times, performance.now() - sentAt))
            if (!stopped && moving) goTo(page + 1)
          })
          .catch((e) => console.log('%c DECISION %c failed', BADGE.decision, BADGE.err, e))
          .finally(() => { deciding = false })
      })
    }
    sheet()
    return () => { stopped = true; stopSheet() }
  },
}

// Motion over SHEET_MOTION starts a sheet (one at a time); the next can start once it's saved and the camera moves
// again. A sheet already started keeps going after the wait ends (the page turned), so it holds the whole flip.
function recordSheets(video, query, page) {
  let recording = false
  const stopMotion = watchMotion(video, (score) => {
    if (recording || score <= SHEET_MOTION) return
    recording = true
    frameSheet(video, ({ blob }) => {
      request(`/turn/sheet?${query}&motion=${score.toFixed(1)}`, { method: 'POST', body: blob })
        .then(({ saved }) => console.log(`%c SHEET %c page ${page + 1} · motion ${score.toFixed(1)}% → ${saved}`,
          BADGE.sheet, BADGE.no))
        .catch((e) => console.log('%c SHEET %c failed', BADGE.sheet, BADGE.err, e))
        .finally(() => { recording = false })
    })
  }, 1) // full frame, same as the sheet
  return stopMotion
}

const constraints = { video: { facingMode: 'user', width: { ideal: 4032 }, height: { ideal: 3024 } }, audio: { echoCancellation: true, noiseSuppression: true } }
export default function Book({ id, cast, onBack }) {
  const voiceOf = (l) => cast[l?.Character] || ''
  const [pages, setPages] = useState(null) // [{img, text: [{Character, Dialogue}]}] in book order
  const [error, setError] = useState('')
  const [index, setIndex] = useState(0)
  const [line, setLine] = useState(0) // the line being read on this page
  const [camStatus, setCamStatus] = useState('Starting camera...')
  const videoRef = useRef(null)
  const lineRef = useRef(null) // the current line's element, to keep it in view 
  const tracking = useRef(null) // { variants (reading.js), line, pageText } of the current child line; null on voiced lines or once read
  const heard = useRef('') // finished phrases said since the current line began
  const pageDone = useRef(null)
  const lineDoneRef = useRef(null) // the latest lineDone()
  const [turnWait, setTurnWait] = useState(false) // last line done: waiting for the real book's page to turn
  const [finished, setFinished] = useState(false) // the book's final line is done
  const pageId = useRef(0) // bumped per page, so a question that arrives after the page turned is dropped
  const asked = useRef([]) // questions already asked on this page, so Bedrock doesn't repeat one
  const [question, setQuestion] = useState(null) // latest follow-up question on this page; a newer one replaces it
  const [showText, setShowText] = useState(false) // the page's lines are hidden unless switched on
  const [paused, setPaused] = useState(false) // paused: no narration, no line matching or questions, no page-turn watch
  const pausedRef = useRef(false) // for onText, which the mic socket holds from the first render
  useEffect(() => { pausedRef.current = paused }, [paused])
  const reading = useRef(`${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}_${id}`)

  // Track the reading progress.
  function onText(text, final) {
    if (!final || pausedRef.current) return
    if (!tracking.current && pageDone.current) { // page finished: nothing left to read, so anything said is talk
      const said = words(text)
      console.log('[track] page done | talk:', text)
      if (said.length >= 2) askQuestion({ ...pageDone.current, unmatched: said.join(' ') })
      return
    }
    if (!tracking.current) return
    heard.current += ` ${text}`
    const { variants: lineVariants, line, pageText, img } = tracking.current
    const result = isRead(lineVariants, heard.current)
    const extra = isRead(lineVariants, text).unmatched // this phrase's words that aren't in the line
    console.log('[track]', result.read ? 'read' : 'not yet', `${Math.round(result.share * 100)}%`,
      result.matches.map((m) => (m.book === m.heard ? m.book : `${m.book}~${m.heard}`)).join(' '),
      ' | not the line:', extra.join(' '))
    if (extra.length >= 2) askQuestion({ line, pageText, img, unmatched: extra.join(' ') })
    if (!result.read) return
    tracking.current = null
    lineDoneRef.current() // reading never waits on a question (same as ../CA)
  }

  // Ask Bedrock for a follow-up question about what the child said, in the background.
  const asking = useRef(false)
  function askQuestion({ line, pageText, img, unmatched }) {
    if (asking.current) return console.log('[question] skipped, one is already on its way:', unmatched)
    asking.current = true
    const forPage = pageId.current
    // book + page_img: the backend sends that page's stored image to GPT as the illustration (as JPEG)
    request('/question', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ page_text: pageText, line, book: id, page_img: img, unmatched, asked: asked.current, reading: reading.current }),
    })
      .then(({ question: q }) => {
        console.log('[question]', q || '(none)')
        if (!q || forPage !== pageId.current) return // nothing to ask, or the page turned meanwhile
        asked.current.push(q)
        setQuestion(q)
      })
      .catch((e) => console.log('[question] failed:', e))
      .finally(() => { asking.current = false })
  }

  // keys keep insertion order: Cover, PageOne, ...; each page keeps its key for the flag button
  const load = () => getJson(`/books/${id}`)
    .then((book) => Object.entries(book[0].Book.Pages).map(([key, p]) => ({ ...p, key })))
  useEffect(() => {
    load().then(setPages).catch((e) => setError(e.message))
  }, [id]) // eslint-disable-line react-hooks/exhaustive-deps -- load only uses id

  const [editing, setEditing] = useState(false)
  const wasPaused = useRef(false)
  function openEdit() {
    wasPaused.current = paused
    setPaused(true)
    setEditing(true)
  }
  function closeEdit() {
    load()
      .then((ps) => { setPages(ps); setLine((l) => Math.min(l, Math.max(0, ps[index].text.length - 1))) })
      .catch((e) => window.alert(`Couldn't reload the book: ${e.message}`))
      .finally(() => { setEditing(false); setPaused(wasPaused.current) })
  }
  
  // Camera + mic on while the book is open; transcripts are logged so you can see the mic working.
  useEffect(() => {
    let stopListening
    const stopCamera = startCamera(
      videoRef.current,
      constraints,
      (s) => { setCamStatus(''), stopListening = listen(s.getAudioTracks()[0], reading.current, id, onText) },
      (e) => { setCamStatus(`Camera/mic unavailable: ${e.name}`); console.log('[mic] failed:', e) },
    )
    return () => {
      stopListening?.()
      stopCamera()
    }
  }, [id])

  const page = pages?.[index]
  const current = page?.text[line]
  const lastLine = !page || line >= page.text.length - 1 // also true on a page with no text
  const atEnd = pages && index === pages.length - 1 && lastLine

  // A line was read or narrated: go to the next line, or on the page's last line wait for the real page to turn
  function lineDone() {
    if (lastLine) pageDone.current = { line: current?.Dialogue ?? '', pageText: page.text.map((l) => l.Dialogue).join('\n'), img: page.img }
    if (atEnd) return setFinished(true)
    if (lastLine) return setTurnWait(true)
    setLine(line + 1)
  }
  function prev() {
    setLine(line - 1)
    setTurnWait(false)
    setFinished(false)
    pageDone.current = null
  }
  function skipLine() {
    tracking.current = null // later speech on this page is talk (questions), not this line, same as onText after a match
    narrator.onended = narrator.onerror = null // a voiced line cut short mustn't call lineDone() again when it ends
    narrator.pause()
    lineDone()
  }

  function toggleFlag() {
    const at = index
    const set = (flagged) => setPages((ps) => ps.map((p, i) => (i === at ? { ...p, flagged } : p)))
    const flagged = !page.flagged
    set(flagged)
    request(`/books/${id}/pages/${page.key}/flag`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ flagged }),
    }).catch((e) => { console.log('[flag] failed:', e); set(!flagged) })
  }
  // Jump to another page's first line; the [index] effect below clears that page's done/turn/question state
  function goPage(i) {
    setIndex(i)
    setLine(0)
    setFinished(false)
  }
  useEffect(() => { lineDoneRef.current = lineDone })

  // A new line starts with nothing heard; only the reader's lines are matched against speech.
  useEffect(() => {
    heard.current = ''
    tracking.current = current && !voiceOf(current)
      ? { variants: variants(current.Dialogue), line: current.Dialogue, pageText: page.text.map((l) => l.Dialogue).join('\n'), img: page.img }
      : null
  }, [current])

  // A new page starts with no question; one still on its way from the last page is dropped.
  useEffect(() => {
    pageId.current++
    asked.current = []
    pageDone.current = null
    setQuestion(null)
    setTurnWait(false)
  }, [index])

  useEffect(() => {
    if (!page || page.text.length) return
    pageDone.current = { line: '', pageText: '', img: page.img }
    if (atEnd) setFinished(true)
    else setTurnWait(true)
  }, [index, pages]) // eslint-disable-line react-hooks/exhaustive-deps -- page and atEnd follow from index and pages

  useEffect(() => {
    const video = videoRef.current
    if (paused || !turnWait || !video?.videoWidth) return
    const query = new URLSearchParams({ book: id, page: index, reading: reading.current })
    const stopCheck = TURN_CHECKS[TURN_CHECK](video, query, index, (p) => { setIndex(p); setLine(0) })
    const stopSheets = SAVE_SHEETS && TURN_CHECK !== 'decision' ? recordSheets(video, query, index) : () => {}
    return () => { stopCheck(); stopSheets() }
  }, [paused, turnWait, index, id])

  // The follow-up question is read aloud when tapped
  const questionAudio = useRef(null)
  useEffect(() => {
    if (!question) return
    questionAudio.current = new Audio(ttsUrl(question, cast.Narrator || 'Aoede')) // starts loading now, so the tap plays sooner
    return () => questionAudio.current.pause()
  }, [question])
  function playQuestion() {
    const audio = questionAudio.current
    audio.currentTime = 0 // tapping again replays from the start
    audio.play().catch((e) => { if (e.name !== 'AbortError') console.log('[tts] play failed:', e) })
  }

  // Generate the next page's narration while this page is read
  useEffect(() => {
    for (const l of pages?.[index + 1]?.text ?? []) {
      if (!voiceOf(l)) continue
      fetch(ttsUrl(l.Dialogue, voiceOf(l))).catch((e) => console.log('[tts] prefetch failed:', e))
    }
  }, [index, pages])

  function playNarrator() {
    narrator.play().catch((e) => { if (e.name !== 'AbortError') console.log('[tts] play failed:', e) })
  }
  // A voiced line is read aloud in its character's voice when it becomes current, then moves on to next line.
  useEffect(() => {
    if (!voiceOf(current)) return
    narrator.src = ttsUrl(current.Dialogue, voiceOf(current))
    narrator.onended = narrator.onerror = () => lineDoneRef.current()
    if (!pausedRef.current) playNarrator()
    return () => {
      narrator.onended = narrator.onerror = null // the next line reuses the element: don't let this one move it on
      narrator.pause()
    }
  }, [current])

  // The voiced line's progress bar: set straight on the element each frame (no re-render); 0 at the start and once
  // the clip ends, so it starts empty for the next line. Reader lines have no bar.
  const barRef = useRef(null)
  useEffect(() => {
    if (!voiceOf(current)) return
    let frame
    const tick = () => {
      const { currentTime: t, duration: d, ended } = narrator
      if (barRef.current) barRef.current.value = ended || !Number.isFinite(d) || !d ? 0 : t / d
      frame = requestAnimationFrame(tick)
    }
    tick()
    return () => cancelAnimationFrame(frame)
  }, [current])

  // Pause/Play holds the voiced line where it is (cached or fresh clip alike: /tts sends a whole WAV)
  useEffect(() => {
    if (!voiceOf(current)) return
    if (paused) narrator.pause()
    else if (!narrator.ended) playNarrator() // an already-finished last line isn't replayed
  }, [paused]) // eslint-disable-line react-hooks/exhaustive-deps -- only on toggle; line changes are handled above

  useEffect(() => { lineRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }) }, [current, showText])

  return (
    <div className="reader">
      <div className="reader-head">
        <button type="button" className="btn btn-outline-light" onClick={onBack}>To Library</button>
        <h1 className="h3 mb-0">Page {index + 1}</h1>
        <div className="reader-head-end">
          <div className="form-check form-switch mb-0">
            <input className="form-check-input" type="checkbox" role="switch" id="show-text"
              checked={showText} onChange={(e) => setShowText(e.target.checked)} />
            <label className="form-check-label" htmlFor="show-text">Show text</label>
          </div>
          {showText && page && (
            <button type="button" className="btn btn-sm btn-outline-light" onClick={openEdit}>Edit</button>
          )}
          <button type="button" className={`reader-flag${page?.flagged ? ' on' : ''}`} disabled={!page}
            aria-pressed={!!page?.flagged} aria-label={page?.flagged ? 'Unflag this page' : 'Flag this page'}
            title={page?.flagged ? 'Flagged for fixing' : 'Flag this page for fixing'} onClick={toggleFlag}>{FlagIcon}</button>
        </div>
      </div>

      {error && <div className="alert alert-danger">Couldn't load book: {error}</div>}
      {!error && !pages && <p>Loading...</p>}
      {page && (
        <div className="reader-text">
          {showText && (page.text.length ? page.text.map((l, i) => (
            <div key={i} ref={i === line ? lineRef : null}
              className={`reader-line${voiceOf(l) ? ' reader-narrator' : ''}${i === line && !turnWait && !finished ? ' reader-current' : ''}`} /* no highlight once the page's last line is done */>
              <span className="reader-speaker">{l.Character}</span>
              <p>{l.Dialogue}</p>
            </div>
          )) : <p className="text-secondary">(No text on this page)</p>)}
          {question && (
            <button type="button" className="reader-line reader-current reader-question" onClick={playQuestion}
              aria-label={`Play question: ${question}`}>
              <span className="reader-speaker">Question</span>
              <p>{question}</p>
            </button>
          )}
        </div>
      )}
      {/* the line cue (bar / mic), centered in the space below the header (and the text, when shown) */}
      <div className="reader-stage">
        {turnWait && (
          <p className="text-secondary" role="status">
            Turn the page
          </p>
        )}
        {current && !turnWait && !finished && (
          <div className="reader-cue" role="status">
            {voiceOf(current) ? (
              <>
                {/* heads-up while the app speaks, when the line after this one (same page) is the reader's */}
                {page.text[line + 1] && !voiceOf(page.text[line + 1]) && <p className="reader-cue-note">Your line is coming up.</p>}
                <progress ref={barRef} className="reader-tts" max={1} value={0} aria-label={`${current.Character} speaking`} />
              </>
            ) : <span className="reader-mic" aria-label="Your turn to read">{MicIcon}</span>}
          </div>
        )}
        {finished && <button type="button" className="btn btn-primary" onClick={onBack}>Back to Library</button>}
      </div>
      {/* at the bottom, above the camera */}
      {pages && (
        <div className="reader-controls">
          <button type="button" aria-label="Previous page" disabled={index === 0} onClick={() => goPage(index - 1)}>{PrevPageIcon}</button>
          <button type="button" aria-label="Previous line" disabled={line === 0} onClick={prev}>{PrevIcon}</button>
          <button type="button" className="reader-play" aria-label={paused ? 'Play' : 'Pause'}
            onClick={() => setPaused(!paused)}>{paused ? PlayIcon : PauseIcon}</button>
          <button type="button" aria-label="Next line" disabled={turnWait || finished} onClick={skipLine}>{NextIcon}</button>
          <button type="button" aria-label="Next page" disabled={index === pages.length - 1} onClick={() => goPage(index + 1)}>{NextPageIcon}</button>
        </div>
      )}

      <div className="reader-cam">
        <video ref={videoRef} autoPlay playsInline muted />
        {camStatus && <span>{camStatus}</span>}
      </div>

      {editing && <div className="reader-edit"><BookEditor id={id} index={index} onBack={closeEdit} /></div>}
    </div>
  )
}
