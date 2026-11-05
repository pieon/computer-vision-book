import { useEffect, useRef, useState } from 'react'
import { getJson, request } from '../api.js'
import { snap, startCamera, watchMotion } from '../camera.js'
import { narrator } from '../narrator.js'
import { isRead, variants } from '../reading.js'

// Connect to deepgram and stream the mic input to the deepgram api. Disconnect mic stream upon closing.
function listen(mic, reading, book, onText) {
  let recorder
  const query = new URLSearchParams({ reading, book }) // book: the backend logs this session's minutes for the Home chart
  const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/listen?${query}`)
  socket.onopen = () => {
    console.log('[stt] connected')
    recorder = new MediaRecorder(new MediaStream([mic]), { mimeType: 'audio/webm' })
    recorder.ondataavailable = (e) => { if (socket.readyState === WebSocket.OPEN) socket.send(e.data) }
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

// high resolution like the Scanner, so the page-turn photo is sharp enough to OCR
const constraints = { video: { facingMode: 'user', width: { ideal: 4032 }, height: { ideal: 3024 } }, audio: { echoCancellation: true, noiseSuppression: true } }
// Reading view: one page's lines at a time, with the camera in a corner and the mic listening.
export default function Book({ id, onBack }) {
  const [pages, setPages] = useState(null) // [{img, text: [{Character, Dialogue}]}] in book order
  const [error, setError] = useState('')
  const [index, setIndex] = useState(0)
  const [line, setLine] = useState(0) // the line being read on this page
  const [camStatus, setCamStatus] = useState('Starting camera...')
  const videoRef = useRef(null)
  const lineRef = useRef(null) // the current line's element, to keep it in view 
  const tracking = useRef(null) // { variants (reading.js), line, pageText } of the current child line; null on Narrator lines or once read
  const heard = useRef('') // finished phrases said since the current line began
  const lineDoneRef = useRef(null) // the latest lineDone()
  const [turnWait, setTurnWait] = useState(false) // last line done: waiting for the real book's page to turn
  const [checking, setChecking] = useState(false) // a page-turn photo is being matched
  const [finished, setFinished] = useState(false) // the book's final line is done
  const [motion, setMotion] = useState(0)
  const pageId = useRef(0) // bumped per page, so a question that arrives after the page turned is dropped
  const asked = useRef([]) // questions already asked on this page, so Bedrock doesn't repeat one
  const [question, setQuestion] = useState(null) // latest follow-up question on this page; a newer one replaces it
  // One id per opening of the book: the backend logs this reading's transcripts and GPT prompts under it (UTC time)
  const reading = useRef(`${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}_${id}`)

  // Track the reading progress.
  function onText(text, final) {
    if (!tracking.current) return
    if (!final) return
    heard.current += ` ${text}`
    const { variants: lineVariants, line, pageText } = tracking.current
    const result = isRead(lineVariants, heard.current)
    console.log('[track]', result.read ? 'read' : 'not yet', `${Math.round(result.share * 100)}%`,
      result.matches.map((m) => (m.book === m.heard ? m.book : `${m.book}~${m.heard}`)).join(' '),
      ' unmatched:', result.unmatched.join(' '))
    if (!result.read) return
    tracking.current = null
    lineDoneRef.current() // reading never waits on a question (same as ../CA)
    if (!result.unmatched.length) return
    // They said more than the line: Bedrock may turn it into a follow-up question in the background
    // (backend/routes/question_acknowledgment.py); an empty one (fillers, chatter) or a failure is just logged.
    const id = pageId.current
    request('/question', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ page_text: pageText, line, unmatched: result.unmatched.join(' '), asked: asked.current, reading: reading.current }),
    })
      .then(({ question: q }) => {
        console.log('[question]', q || '(none)')
        if (!q || id !== pageId.current) return // nothing to ask, or the page turned meanwhile
        asked.current.push(q)
        setQuestion(q)
      })
      .catch((e) => console.log('[question] failed:', e))
  }

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

  // Next: the page's next line, or the first line of the next page. Called by the button, by speech and by narration.
  function next() {
    if (atEnd) return
    if (!lastLine) return setLine(line + 1)
    setIndex(index + 1)
    setLine(0)
  }
  // A line was read or narrated: go to the next line, but after a page's last line wait for the real page to turn
  // (the Next button still turns it by hand).
  function lineDone() {
    if (atEnd) return setFinished(true)
    if (lastLine) return setTurnWait(true)
    next()
  }
  useEffect(() => { lineDoneRef.current = lineDone })

  // A new line starts with nothing heard; only a child's line is matched against speech.
  useEffect(() => {
    heard.current = ''
    tracking.current = current && current.Character !== 'Narrator'
      ? { variants: variants(current.Dialogue), line: current.Dialogue, pageText: page.text.map((l) => l.Dialogue).join('\n') }
      : null
  }, [current]) // eslint-disable-line react-hooks/exhaustive-deps -- page changes only along with current

  // A new page starts with no question; one still on its way from the last page is dropped.
  useEffect(() => {
    pageId.current++
    asked.current = []
    setQuestion(null)
    setTurnWait(false)
  }, [index])

  // Waiting for a page turn, same motion score as the Scanner: over 12 = the page is moving; once it has stayed under
  // 5 for 700 ms, snap it and ask the backend which page it is (backend/routes/scan.py /turn). Next page: go there;
  // same page, a turn back, or a failure (e.g. a hand passed by): keep watching.
  useEffect(() => {
    const video = videoRef.current
    if (!turnWait || !video?.videoWidth) return // no camera: the Next button still works
    let moving = false
    let movedAt = null // first frame over 12, for the stage times below
    let stillSince = null
    let busy = false
    let stopped = false
    const stop = watchMotion(video, (score) => {
      setMotion(score)
      if (busy) return
      if (score > 12) { moving = true; movedAt ??= performance.now() }
      if (score >= 5) stillSince = null
      else if (moving) {
        stillSince ??= performance.now()
        if (performance.now() - stillSince < 700) return
        moving = false
        busy = true
        setChecking(true)
        const snapAt = performance.now()
        // flip: first motion -> settling began; settle: the 700 ms still wait; snap: photo encode; then the request
        const t = { flip: stillSince - movedAt, settle: snapAt - stillSince }
        movedAt = null
        snap(video, ({ blob, url }) => {
          URL.revokeObjectURL(url)
          const sentAt = performance.now()
          t.snap = sentAt - snapAt
          const query = new URLSearchParams({ book: id, page: index, reading: reading.current })
          request(`/turn?${query}`, { method: 'POST', body: blob })
            .then(({ page: p, scores, times }) => {
              t.request = performance.now() - sentAt
              const server = Object.values(times).reduce((a, b) => a + b, 0) * 1000
              const ms = (v) => `${Math.round(v)}ms`
              console.log('[turn]', index, '->', p, scores,
                `| flip ${ms(t.flip)} settle ${ms(t.settle)} snap ${ms(t.snap)} (${Math.round(blob.size / 1024)} KB)`,
                `request ${ms(t.request)} = server ${ms(server)} [${Object.entries(times).map(([k, v]) => `${k} ${ms(v * 1000)}`).join(' ')}]`,
                `+ network ${ms(t.request - server)} | total ${ms(t.flip + t.settle + t.snap + t.request)}`)
              if (!stopped && p !== index) { setIndex(p); setLine(0) }
            })
            .catch((e) => console.log('[turn] failed:', e))
            .finally(() => { busy = false; if (!stopped) setChecking(false) })
        })
      }
    })
    return () => { stopped = true; stop(); setChecking(false) }
  }, [turnWait, index, id])

  // The follow-up question is read aloud when tapped (same cached TTS as narration); a newer question, a page turn or
  // leaving stops it.
  const questionAudio = useRef(null)
  useEffect(() => {
    if (!question) return
    questionAudio.current = new Audio(`/tts?text=${encodeURIComponent(question)}`) // starts loading now, so the tap plays sooner
    return () => questionAudio.current.pause()
  }, [question])
  function playQuestion() {
    const audio = questionAudio.current
    audio.currentTime = 0 // tapping again replays from the start
    audio.play().catch((e) => { if (e.name !== 'AbortError') console.log('[tts] play failed:', e) })
  }

  // Generate the next page's narration while this page is read: the first /tts request makes and caches a clip
  // (backend/routes/tts.py), so after the turn it plays without waiting on generation. Same URL as narration below.
  useEffect(() => {
    for (const l of pages?.[index + 1]?.text ?? []) {
      if (l.Character !== 'Narrator') continue
      fetch(`/tts?text=${encodeURIComponent(l.Dialogue)}`).catch((e) => console.log('[tts] prefetch failed:', e))
    }
  }, [index, pages])

  // A Narrator line is read aloud when it becomes current, then moves on to next line. It plays through the shared
  // `narrator` element that the book's opening tap unlocked (narrator.js), so Safari also allows it after a page turn.
  useEffect(() => {
    if (current?.Character !== 'Narrator') return
    narrator.src = `/tts?text=${encodeURIComponent(current.Dialogue)}`
    narrator.onended = narrator.onerror = () => lineDoneRef.current()
    narrator.play().catch((e) => { if (e.name !== 'AbortError') console.log('[tts] play failed:', e) })
    return () => {
      narrator.onended = narrator.onerror = null // the next line reuses the element: don't let this one move it on
      narrator.pause()
    }
  }, [current])

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
              className={`reader-line${l.Character === 'Narrator' ? ' reader-narrator' : ''}${i === line && !turnWait && !finished ? ' reader-current' : ''}`} /* no highlight once the page's last line is done */>
              <span className="reader-speaker">{l.Character}</span>
              <p>{l.Dialogue}</p>
            </div>
          )) : <p className="text-secondary">(No text on this page)</p>}
          {question && (
            <button type="button" className="reader-line reader-current reader-question" onClick={playQuestion}
              aria-label={`Play question: ${question}`}>
              <span className="reader-speaker">Question</span>
              <p>{question}</p>
            </button>
          )}
        </div>
      )}
      {turnWait && (
        <p className="text-secondary" role="status">
          {checking ? 'Checking the page...' : `Turn the page · motion ${motion.toFixed(1)}%`}
        </p>
      )}
      {pages && !atEnd && (
        <button type="button" className="btn btn-primary" onClick={next}>Next</button>
      )}
      {finished && <button type="button" className="btn btn-primary" onClick={onBack}>Back to Library</button>}

      <div className="reader-cam">
        <video ref={videoRef} autoPlay playsInline muted />
        {camStatus && <span>{camStatus}</span>}
      </div>
    </div>
  )
}
