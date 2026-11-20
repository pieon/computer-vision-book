import { useEffect, useRef, useState } from 'react'
import { getJson, request, timing, ttsUrl } from '../api.js'
import { frameBuffer, frameSheet, snap, startCamera, watchMotion } from '../camera.js'
import { FlagIcon, MicIcon, NextIcon, NextPageIcon, PauseIcon, PlayIcon, PrevIcon, PrevPageIcon } from '../components/icons.jsx'
import { narrator } from '../narrator.js'
import BookEditor from './BookEditor.jsx'
import PagePick from './PagePick.jsx'
import { isRead, variants, words } from '../reading.js'
import { FALLBACK_AFTER, mixedStep, ORB_SURE, START } from '../fallback.js'
import { Orb, orbOf } from '../components/Orb.jsx'

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

// What turns the page: 'orb', 'decision', or 'mixed' (ORB, with the decision model as fallback; fallback.js)
const TURN_CHECK = 'mixed'
// With 'decision' turning the pages, also run 'mixed' alongside and only log what it does ("MIXED" lines, never turns)
const SHADOW_MIXED = true
// Save a 10-frame sheet of each flip (recordSheets), centred on the motion peak
const SAVE_SHEETS = true
// Motion (% of pixels changed) above this is a burst; its highest reading is the peak
const SHEET_MOTION = 7
// Frames in a sheet before and after the peak (150 ms apart)
const SHEET_BEFORE = 5
const SHEET_AFTER = 5
// While waiting for a turn: after this many ORB replies in a row that see neither page clearly, the voice agents ask
// "We want to see the book too!". A reply comes about every 0.5 s (server ~0.4 s: unwarp + match), so ~3 s: past a
// hand passing over the book, soon enough for the child to fix it.
const SHOW_BOOK_AFTER = 6

// Console badges for the page-turn checks (filter "ORB" / "DECISION")
const BADGE = {
  orb: 'background:#1e6fd9;color:#fff;font-weight:bold;border-radius:3px',
  decision: 'background:#e67e22;color:#fff;font-weight:bold;border-radius:3px',
  sheet: 'background:#8e44ad;color:#fff;font-weight:bold;border-radius:3px',
  mixed: 'background:#16a085;color:#fff;font-weight:bold;border-radius:3px',
  yes: 'color:#27ae60;font-weight:bold', // turned / moving
  no: 'color:inherit',
  err: 'color:#e74c3c;font-weight:bold',
}

// ORB page check, nonstop: snap the full frame, POST /turn, then onReply(reply, { blob, snapAt, sentAt, stopped }) and
// the next photo. snapAt = when the photo was taken. Returns a stop function.
// ponytail: one request in flight at a time, nonstop while waiting; add a short gap if the server load matters
function orbLoop(video, query, onReply, name = 'ORB') {
  let stopped = false
  const check = () => {
    if (!video.srcObject?.active) return // camera stopped (left the book): nothing left to photograph
    const snapAt = performance.now()
    snap(video, ({ blob, url }) => {
      URL.revokeObjectURL(url)
      const sentAt = performance.now()
      request(`/turn?${query}`, { method: 'POST', body: blob })
        .then((reply) => onReply(reply, { blob, snapAt, sentAt, stopped }))
        .catch((e) => console.log(`%c ${name} %c failed`, BADGE.orb, BADGE.err, e))
        .finally(() => { if (!stopped) check() })
    }, { maxWidth: 1400, quality: 0.8 }) // full frame: the page is found wherever the book sits
  }
  check()
  return () => { stopped = true }
}

const TURN_CHECKS = {
  orb(video, query, page, goTo, onOrb) {
    return orbLoop(video, query, ({ page: p, scores, version, times }, { blob, sentAt, stopped }) => {
      if (!stopped) onOrb?.({ page: p, scores })
      // per page: inliers / keypoints in that page's fingerprint (good = matches passing the ratio test)
      const counts = (s) => Object.entries(s).map(([k, v]) => `p${+k + 1} ${v.inliers}/${v.total} (good ${v.good})`).join(' · ')
      const verdict = (to) => (to !== page ? `TURNED to page ${to + 1}` : 'same page')
      const after = stopped ? ' · (after turn)' : ''
      const via = version ? ` · via reading version ${version}` : '' // the scan failed, a saved reading photo matched
      console.log(`%c ORB %c page ${page + 1} → ${verdict(p)} · ${counts(scores)} · 25 to turn${via}${after}`,
        BADGE.orb, p !== page ? BADGE.yes : BADGE.no,
        `| ${Math.round(blob.size / 1024)} KB |`, timing({}, times, performance.now() - sentAt))
      if (!stopped && p !== page) goTo(p)
    })
  },

  // a sheet done while a request is in flight is dropped
  // The backend turns only on "page_turn" with p >= 0.9 (turn.py TURN_P); a less sure "page_turn", "no_turn" and
  // "unclear" all mean not turned this round.
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
          .then(({ choice, page_turn: turned, p, error, saved, times }) => {
            const answer = error ? `error ${error}` : turned ? `PAGE TURN (p ${p}) → page ${page + 2}`
              : choice === 'page_turn' ? `page_turn (p ${p}), below 0.9: not turned` : `${choice} (p ${p})`
            console.log(`%c DECISION %c page ${page + 1} · ${answer}${stopped ? ' · (after turn)' : ''}`,
              BADGE.decision, error ? BADGE.err : turned ? BADGE.yes : BADGE.no,
              `| ${saved} |`, timing({ capture: ms }, times, performance.now() - sentAt))
            if (!stopped && turned) goTo(page + 1, 'decision')
          })
          .catch((e) => console.log('%c DECISION %c failed', BADGE.decision, BADGE.err, e))
          .finally(() => { deciding = false })
      })
    }
    sheet()
    return () => { stopped = true; stopSheet() }
  },
}

// Frames are kept in a rolling buffer (camera.js frameBuffer). A burst of motion over SHEET_MOTION is followed to its
// end; its highest reading is the peak (the middle of the flip), and the sheet holds SHEET_BEFORE frames up to it and
// SHEET_AFTER after it. One sheet at a time: bursts are ignored until it's saved. Stopping (the page turned) still
// finishes a sheet already asked for, so the flip that turned the page is saved.
// onSheet({ blob, peak, at }) gets each sheet (the mixed method's candidates); it's saved to /turn/sheet if SAVE_SHEETS.
function recordSheets(video, query, page, onSheet) {
  const buffer = frameBuffer(video)
  let recording = false
  let burst = null // { max, at }: the highest motion reading so far in this burst, and when
  const stopMotion = watchMotion(video, (score) => {
    if (score > SHEET_MOTION) {
      if (!burst || score > burst.max) burst = { max: score, at: performance.now() }
      return
    }
    if (!burst) return
    const peak = burst // burst over
    burst = null
    if (recording) return
    recording = true
    buffer.sheet(peak.at, SHEET_BEFORE, SHEET_AFTER, ({ blob }) => {
      onSheet?.({ blob, peak: peak.max, at: peak.at })
      if (!SAVE_SHEETS) { recording = false; return }
      request(`/turn/sheet?${query}&motion=${peak.max.toFixed(1)}&trigger=peak`, { method: 'POST', body: blob })
        .then(({ saved }) => console.log(`%c SHEET %c page ${page + 1} · peak ${peak.max.toFixed(1)}% → ${saved}`,
          BADGE.sheet, BADGE.no))
        .catch((e) => console.log('%c SHEET %c failed', BADGE.sheet, BADGE.err, e))
        .finally(() => { recording = false })
    })
  }) // full frame, same as the sheet
  return () => { stopMotion(); buffer.stop() }
}

// The mixed method: its own ORB loop plus the motion-peak sheets (via onSheet), run through fallback.js mixedStep; when
// it says so, the chosen sheet goes to the decision model. Prints "MIXED" lines. Returns { onSheet, stop }.
// - With goTo (TURN_CHECK 'mixed'): it turns the page (to ORB's page, or the next one on the model's page_turn) and
//   stop() ends it at once.
// - Without (SHADOW_MIXED, logged only): it never turns the page, and stop() (usually: the real check just turned it)
//   doesn't cut it off: it keeps checking the old page until it reaches its own answer (ORB sees the next page, or the
//   model answers) or MIXED_LINGER_MS pass, so every flip gets a MIXED result to compare. Those lines say "(after turn)".
const MIXED_LINGER_MS = 6000
function mixedCheck(video, query, page, goTo = null, onOrb = null) {
  let state = START
  let stopped = false // stop() was called: lingering for an answer
  let finished = false // the ORB loop is stopped
  let linger = null
  let orbPage = page + 1 // the page ORB matched in its latest reply, for a turn by ORB
  const say = (msg, style = BADGE.no) => console.log(`%c MIXED %c page ${page + 1} · ${msg}${stopped ? ' · (after turn)' : ''}`,
    BADGE.mixed, style)
  function finish() {
    if (finished) return
    finished = true
    clearTimeout(linger)
    stopOrb()
  }
  function feed(event) {
    const r = mixedStep(state, event)
    state = r.state
    if (r.log) say(r.log, r.action?.done ? BADGE.yes : BADGE.no)
    if (goTo && !stopped && r.action?.done) goTo(r.action.done === 'orb' ? orbPage : page + 1, r.action.done)
    if (r.action?.decide) {
      request(`/turn/decide?${query}`, { method: 'POST', body: r.action.decide.blob })
        .then(({ choice, page_turn: turned, p, error }) => feed({ type: 'decision', turned, choice, p, error }))
        .catch((e) => feed({ type: 'decision', turned: false, error: e.message }))
    }
    if (stopped && (state.done || event.type === 'decision')) finish() // lingering, and it has its answer
  }
  const stopOrb = orbLoop(video, query, ({ page: p, scores, version }, { snapAt }) => {
    if (finished) return
    if (!stopped) onOrb?.({ page: p, scores }) // not while lingering on the old page
    if (version) say(`ORB matched page ${p + 1} via reading version ${version}`)
    if (p !== page) orbPage = p
    feed({ type: 'orb', next: p !== page, current: scores[page]?.inliers ?? 0, at: snapAt })
  }, 'MIXED ORB')
  return {
    onSheet: ({ blob, peak, at }) => feed({ type: 'sheet', blob, peak, at }),
    stop() {
      if (stopped) return
      stopped = true
      if (goTo || state.done) return finish() // in charge (it turned the page, or the wait ended), or already answered
      linger = setTimeout(() => {
        const n = state.candidates.length
        say(`no answer within ${MIXED_LINGER_MS / 1000} s (${n} candidate sheet${n === 1 ? '' : 's'}, ORB unsure ${state.unsure}/${FALLBACK_AFTER}${state.deciding ? ', model still deciding' : ''})`)
        finish()
      }, MIXED_LINGER_MS)
    },
  }
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
  const [askBook, setAskBook] = useState(false) // waiting for a turn and ORB can't see the book: the voices ask to see it
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
  // The voice agents picked in Cast, one per voice (Narrator first; Onomatopoeia shares the Narrator's), with the
  // characters each reads; the child's own characters ('') aren't in the row. The one reading the current line is big.
  const agents = Object.entries(cast).reduce((list, [name, voice]) => {
    if (!voice || name === 'Onomatopoeia' || !orbOf(voice)) return list
    const at = list.find((a) => a.voice === voice)
    if (at) at.names.push(name)
    else list.push({ voice, orb: orbOf(voice), names: [name] })
    return list
  }, [])
  const speaking = !turnWait && !finished ? voiceOf(current) : ''

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

  // A decision-model turn: show its guess (the next page) and hold reading until the user picks the page they're on
  // (PagePick). Its photo is kept with the picked page; leaving hands them to the Library's CropPhotos screen. The turn
  // check only runs while not paused, so un-pausing after the pick restores it.
  // ponytail: shots are kept in memory only; unmarked ones are lost if the app reloads. Upload them as taken if that matters
  const shots = useRef([]) // [{ blob, url, page }]
  const [confirm, setConfirm] = useState(null) // { blob, url, page: the guess } while the carousel is open
  function decisionTurn(video, p) {
    setPaused(true)
    setConfirm({ page: p }) // open now; the photo joins it once encoded (a pick before that keeps no photo)
    snap(video, (s) => setConfirm((c) => (c ? { ...c, ...s } : (URL.revokeObjectURL(s.url), null)))) // full frame
  }
  function pick(i) {
    goPage(i)
    if (confirm.blob) shots.current.push({ ...confirm, page: i })
    setConfirm(null)
    setPaused(false)
  }
  const leave = () => onBack(shots.current) // the Library opens CropPhotos if there are any

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
    const goTo = (p, by) => {
      setIndex(p)
      setLine(0)
      if (by === 'decision') decisionTurn(video, p)
    }
    // 'mixed' turns the page itself; beside 'decision' a logged-only copy can run (beside 'orb' it would just be a
    // second ORB loop). Either needs the motion-peak sheets, so they're made in decision mode too when one runs.
    // every ORB reply: count the unsure ones in a row (neither page clearly seen) for the "see the book" bubble
    let unsure = 0
    const onOrb = ({ page: p, scores }) => {
      unsure = p !== index || (scores[index]?.inliers ?? 0) >= ORB_SURE ? 0 : unsure + 1
      setAskBook(unsure >= SHOW_BOOK_AFTER)
    }
    const mixed = TURN_CHECK === 'mixed' ? mixedCheck(video, query, index, goTo, onOrb)
      : SHADOW_MIXED && TURN_CHECK === 'decision' ? mixedCheck(video, query, index, null, onOrb) : null
    const stopCheck = TURN_CHECK === 'mixed' ? () => {} : TURN_CHECKS[TURN_CHECK](video, query, index, goTo, onOrb)
    const stopSheets = (SAVE_SHEETS && TURN_CHECK !== 'decision') || mixed
      ? recordSheets(video, query, index, mixed?.onSheet) : () => {}
    return () => { stopCheck(); stopSheets(); mixed?.stop(); setAskBook(false) }
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
        <button type="button" className="btn btn-outline-light" onClick={leave}>To Library</button>
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
        {agents.length > 0 && (
          <div className="reader-cast-wrap">
            {askBook && <p className="reader-cast-bubble" role="status">We want to see the book too!</p>}
            <div className={`reader-cast${askBook ? ' looking' : ''}`}>
              {agents.map(({ voice, orb, names }) => (
                <div key={voice} className={`reader-cast-item${speaking === voice ? ' speaking' : ''}`}>
                  <Orb orb={orb} size={56} label={false} />
                  <span className="reader-cast-name">{names.join(', ')}</span>
                </div>
              ))}
            </div>
          </div>
        )}
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
        {finished && <button type="button" className="btn btn-primary" onClick={leave}>Back to Library</button>}
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
      {confirm && pages && <PagePick id={id} pages={pages} guess={confirm.page} onPick={pick} />}
    </div>
  )
}
