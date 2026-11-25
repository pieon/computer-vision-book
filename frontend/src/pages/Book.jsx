import { useEffect, useRef, useState } from 'react'
import { getJson, request, timing, ttsUrl } from '../api.js'
import { frameBuffer, frameSheet, snap, startCamera, watchMotion } from '../camera.js'
import { FlagIcon, MicIcon, NextIcon, NextPageIcon, PauseIcon, PlayIcon, PrevIcon, PrevPageIcon } from '../components/icons.jsx'
import { narrator } from '../narrator.js'
import { duck, loadModes, playEffect, preload, saveModes, setLoop, stopAll } from '../sounds.js'
import BookEditor from './BookEditor.jsx'
import PagePick from './PagePick.jsx'
import { isRead, variants, words } from '../reading.js'
import { FALLBACK_AFTER, mixedStep, ORB_SURE, START } from '../fallback.js'
import { Orb, orbOf } from '../components/Orb.jsx'

// Stream the mic to /listen (Deepgram). Returns a stop function.
function listen(mic, reading, book, onText) {
  let recorder
  const query = new URLSearchParams({ reading, book }) // book: for Home's reading time
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

// Page-turn check: 'orb', 'decision', or 'mixed' (ORB, decision model as fallback)
const TURN_CHECK = 'mixed'
// With 'decision', also run 'mixed' log-only
const SHADOW_MIXED = true
// Save a frame sheet of each flip
const SAVE_SHEETS = true
// Motion % that starts a burst
const SHEET_MOTION = 7
// Frames before / after the peak
const SHEET_BEFORE = 5
const SHEET_AFTER = 5
// Unsure ORB replies in a row (~3 s) before asking to see the book
const SHOW_BOOK_AFTER = 6
const NEXT_SHOT_MS = 1000 // Next page photo delay, so the hand is gone

// Console badges
const BADGE = {
  orb: 'background:#1e6fd9;color:#fff;font-weight:bold;border-radius:3px',
  decision: 'background:#e67e22;color:#fff;font-weight:bold;border-radius:3px',
  sheet: 'background:#8e44ad;color:#fff;font-weight:bold;border-radius:3px',
  mixed: 'background:#16a085;color:#fff;font-weight:bold;border-radius:3px',
  yes: 'color:#27ae60;font-weight:bold', // turned / moving
  no: 'color:inherit',
  err: 'color:#e74c3c;font-weight:bold',
}

// Nonstop ORB page check: snap, POST /turn, onReply. Returns a stop function.
// ponytail: one request at a time, no gap; add one if server load matters
function orbLoop(video, query, onReply, name = 'ORB') {
  let stopped = false
  const check = () => {
    if (!video.srcObject?.active) return // camera stopped
    const snapAt = performance.now()
    snap(video, ({ blob, url }) => {
      URL.revokeObjectURL(url)
      const sentAt = performance.now()
      request(`/turn?${query}`, { method: 'POST', body: blob })
        .then((reply) => onReply(reply, { blob, snapAt, sentAt, stopped }))
        .catch((e) => console.log(`%c ${name} %c failed`, BADGE.orb, BADGE.err, e))
        .finally(() => { if (!stopped) check() })
    }, { maxWidth: 1400, quality: 0.8 })
  }
  check()
  return () => { stopped = true }
}

const TURN_CHECKS = {
  orb(video, query, page, goTo, onOrb) {
    return orbLoop(video, query, ({ page: p, scores, version, times }, { blob, sentAt, stopped }) => {
      if (!stopped) onOrb?.({ page: p, scores })
      // per page: inliers / keypoints (good = passed the ratio test)
      const counts = (s) => Object.entries(s).map(([k, v]) => `p${+k + 1} ${v.inliers}/${v.total} (good ${v.good})`).join(' · ')
      const verdict = (to) => (to !== page ? `TURNED to page ${to + 1}` : 'same page')
      const after = stopped ? ' · (after turn)' : ''
      const via = version ? ` · via reading version ${version}` : '' // matched a saved reading photo
      console.log(`%c ORB %c page ${page + 1} → ${verdict(p)} · ${counts(scores)} · 25 to turn${via}${after}`,
        BADGE.orb, p !== page ? BADGE.yes : BADGE.no,
        `| ${Math.round(blob.size / 1024)} KB |`, timing({}, times, performance.now() - sentAt))
      if (!stopped && p !== page) goTo(p)
    })
  },

  // Decision model on motion sheets; turns only on a sure "page_turn" (turn.py TURN_P)
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
              : choice === 'page_turn' ? `page_turn (p ${p}), below the cutoff (turn.py TURN_P): not turned` : `${choice} (p ${p})`
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

// A frame sheet around each motion peak (a flip), passed to onSheet and saved if SAVE_SHEETS
function recordSheets(video, query, page, onSheet) {
  const buffer = frameBuffer(video)
  let recording = false
  let burst = null // { max, at } of this burst
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
  })
  return () => { stopMotion(); buffer.stop() }
}

// Mixed method: ORB + motion sheets through fallback.js mixedStep. With goTo it turns the page;
// without, it only logs, lingering up to MIXED_LINGER_MS after stop() for its answer.
const MIXED_LINGER_MS = 6000
function mixedCheck(video, query, page, goTo = null, onOrb = null) {
  let state = START
  let stopped = false // lingering for an answer
  let finished = false
  let linger = null
  let orbPage = page + 1 // ORB's latest page
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
    if (stopped && (state.done || event.type === 'decision')) finish()
  }
  const stopOrb = orbLoop(video, query, ({ page: p, scores, version }, { snapAt }) => {
    if (finished) return
    if (!stopped) onOrb?.({ page: p, scores })
    if (version) say(`ORB matched page ${p + 1} via reading version ${version}`)
    if (p !== page) orbPage = p
    feed({ type: 'orb', next: p !== page, current: scores[page]?.inliers ?? 0, at: snapAt })
  }, 'MIXED ORB')
  return {
    onSheet: ({ blob, peak, at }) => feed({ type: 'sheet', blob, peak, at }),
    stop() {
      if (stopped) return
      stopped = true
      if (goTo || state.done) return finish()
      linger = setTimeout(() => {
        const n = state.candidates.length
        say(`no answer within ${MIXED_LINGER_MS / 1000} s (${n} candidate sheet${n === 1 ? '' : 's'}, ORB unsure ${state.unsure}/${FALLBACK_AFTER}${state.deciding ? ', model still deciding' : ''})`)
        finish()
      }, MIXED_LINGER_MS)
    },
  }
}

const constraints = { video: { facingMode: 'user', width: { ideal: 4032 }, height: { ideal: 3024 } }, audio: { echoCancellation: true, noiseSuppression: true } }
// startPage: the page to open on (from Home)
export default function Book({ id, cast, onBack, startPage = 0 }) {
  const voiceOf = (l) => cast[l?.Character] || ''
  const [pages, setPages] = useState(null) // [{img, text: [{Character, Dialogue}]}]
  const [error, setError] = useState('')
  const [index, setIndex] = useState(startPage)
  const [line, setLine] = useState(0)
  const [camStatus, setCamStatus] = useState('Starting camera...')
  const videoRef = useRef(null)
  const lineRef = useRef(null)
  const tracking = useRef(null) // the child line being matched, or null
  const heard = useRef('')
  const pageDone = useRef(null)
  const lineDoneRef = useRef(null)
  const [turnWait, setTurnWait] = useState(false) // waiting for the real page turn
  const [finished, setFinished] = useState(false)
  const pageId = useRef(0) // drops late questions
  const asked = useRef([])
  const [question, setQuestion] = useState(null)
  const [askBook, setAskBook] = useState(false)
  const [showText, setShowText] = useState(false)
  const [paused, setPaused] = useState(false)
  const pausedRef = useRef(false)
  useEffect(() => { pausedRef.current = paused }, [paused])
  const reading = useRef(`${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}_${id}`)

  // Track the reading progress.
  function onText(text, final) {
    const ws = wordSound.current
    if (ws && !ws.narrated && !pausedRef.current && words(text).includes(ws.word)) {
      wordSound.current = null
      playEffect(ws.sound, `said "${ws.word}"`)
    }
    if (!final || pausedRef.current) return
    if (!tracking.current && pageDone.current) { // page done: speech is talk
      const said = words(text)
      console.log('[track] page done | talk:', text)
      if (said.length >= 2) askQuestion({ ...pageDone.current, unmatched: said.join(' ') })
      return
    }
    if (!tracking.current) return
    heard.current += ` ${text}`
    const { variants: lineVariants, line, pageText, img } = tracking.current
    const result = isRead(lineVariants, heard.current)
    const extra = isRead(lineVariants, text).unmatched
    console.log('[track]', result.read ? 'read' : 'not yet', `${Math.round(result.share * 100)}%`,
      result.matches.map((m) => (m.book === m.heard ? m.book : `${m.book}~${m.heard}`)).join(' '),
      ' | not the line:', extra.join(' '))
    if (extra.length >= 2) askQuestion({ line, pageText, img, unmatched: extra.join(' ') })
    if (!result.read) return
    tracking.current = null
    lineDoneRef.current()
  }

  // Follow-up question, in the background
  const asking = useRef(false)
  function askQuestion({ line, pageText, img, unmatched }) {
    if (asking.current) return console.log('[question] skipped, one is already on its way:', unmatched)
    asking.current = true
    const forPage = pageId.current
    request('/question', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ page_text: pageText, line, book: id, page_img: img, unmatched, asked: asked.current, reading: reading.current }),
    })
      .then(({ question: q }) => {
        console.log('[question]', q || '(none)')
        if (!q || forPage !== pageId.current) return
        asked.current.push(q)
        setQuestion(q)
      })
      .catch((e) => console.log('[question] failed:', e))
      .finally(() => { asking.current = false })
  }

  const load = () => getJson(`/books/${id}`)
    .then((book) => Object.entries(book[0].Book.Pages).map(([key, p]) => ({ ...p, key })))
  useEffect(() => {
    load().then((ps) => { setPages(ps); setIndex((i) => Math.min(i, ps.length - 1)) }).catch((e) => setError(e.message))
  }, [id]) // eslint-disable-line react-hooks/exhaustive-deps

  // Save where reading is, for Home's Last Read Book
  useEffect(() => {
    if (!pages) return
    request(`/books/${id}/reading`, { method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ page: index, finished, cast }) }).catch((e) => console.log('[reading] not saved:', e))
  }, [pages, index, finished]) // eslint-disable-line react-hooks/exhaustive-deps

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
  
  // Camera + mic while the book is open
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
  const lastLine = !page || line >= page.text.length - 1
  const atEnd = pages && index === pages.length - 1 && lastLine
  // Voice row: one orb per voice, with its characters
  const agents = Object.entries(cast).reduce((list, [name, voice]) => {
    if (!voice || name === 'Onomatopoeia' || !orbOf(voice)) return list
    const at = list.find((a) => a.voice === voice)
    if (at) at.names.push(name)
    else list.push({ voice, orb: orbOf(voice), names: [name] })
    return list
  }, [])
  const speaking = !turnWait && !finished ? voiceOf(current) : ''

  // Next line, or wait for the page turn
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
    tracking.current = null
    narrator.onended = narrator.onerror = null
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
  function goPage(i) {
    setIndex(i)
    setLine(0)
    setFinished(false)
  }
  useEffect(() => { lineDoneRef.current = lineDone })

  // Decision-model turn: pause and ask which page (PagePick); its photo goes to CropPhotos
  // ponytail: shots live in memory, lost on reload; upload as taken if that matters
  const shots = useRef([]) // [{ blob, url, page }]
  const [confirm, setConfirm] = useState(null) // { blob, url, page } while PagePick is open
  function decisionTurn(video, p) {
    setPaused(true)
    setConfirm({ page: p })
    snap(video, (s) => setConfirm((c) => (c ? { ...c, ...s } : (URL.revokeObjectURL(s.url), null))))
  }
  function pick(i) {
    goPage(i)
    if (confirm.blob) shots.current.push({ ...confirm, page: i })
    setConfirm(null)
    setPaused(false)
  }
  // Next page button: no PagePick; a photo for CropPhotos after NEXT_SHOT_MS
  function nextPage() {
    const p = index + 1
    goPage(p)
    const video = videoRef.current
    setTimeout(() => {
      if (video?.videoWidth && video.srcObject?.active) snap(video, (s) => shots.current.push({ ...s, page: p }))
    }, NEXT_SHOT_MS)
  }
  const leave = () => onBack(shots.current)

  // New line: match only the reader's lines
  useEffect(() => {
    heard.current = ''
    tracking.current = current && !voiceOf(current)
      ? { variants: variants(current.Dialogue), line: current.Dialogue, pageText: page.text.map((l) => l.Dialogue).join('\n'), img: page.img }
      : null
  }, [current])

  // New page: clear its question state
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
  }, [index, pages]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const video = videoRef.current
    if (paused || !turnWait || !video?.videoWidth) return
    const query = new URLSearchParams({ book: id, page: index, reading: reading.current })
    const goTo = (p, by) => {
      setIndex(p)
      setLine(0)
      if (modesRef.current.cues) playEffect(cuesRef.current.turn, 'cue: page turned')
      if (by === 'decision') decisionTurn(video, p)
    }
    // unsure ORB replies in a row, for the "see the book" bubble
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

  // Sound effects, in the modes picked in the Sounds menu (sounds.js)
  const [modes, setModes] = useState(loadModes)
  const modesRef = useRef(modes)
  useEffect(() => { modesRef.current = modes; saveModes(modes) }, [modes])
  const cuesRef = useRef({})
  useEffect(() => {
    if (modes.cues && !cuesRef.current.turn) getJson('/sounds/cues').then((c) => { cuesRef.current = c }).catch((e) => console.log('[sfx] cues failed:', e))
  }, [modes.cues])
  useEffect(() => stopAll, []) // leaving stops everything
  const sounds = page?.sounds
  // preload this page's and the next page's sounds
  const nextSounds = pages?.[index + 1]?.sounds
  useEffect(() => {
    preload([sounds, nextSounds].flatMap((s) => [s?.setting, ...Object.values(s?.lines ?? {})]))
  }, [sounds, nextSounds])
  useEffect(() => { setLoop(modes.setting && !paused && !confirm && !turnWait && !finished ? sounds?.setting ?? null : null) }, [modes.setting, paused, confirm, turnWait, finished, sounds])
  useEffect(() => { duck(!!current && !voiceOf(current) && !turnWait && !finished) }, [current, turnWait, finished]) // eslint-disable-line react-hooks/exhaustive-deps
  const wordSound = useRef(null) // pending word-timed effect
  useEffect(() => {
    const sound = sounds?.lines?.[line]
    wordSound.current = null
    if (!sound || !current || pausedRef.current) return
    if (modes.effects === 'line') return playEffect(sound, 'line start')
    if (modes.effects !== 'word') return
    const word = words(sound.word)[0]
    const all = words(current.Dialogue)
    wordSound.current = { sound, word, narrated: !!voiceOf(current), at: Math.max(0, all.indexOf(word)) / all.length }
  }, [current]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (finished && modes.cues) playEffect(cuesRef.current.end, 'cue: book finished') }, [finished]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (askBook && modes.cues) playEffect(cuesRef.current.ask, 'cue: see the book') }, [askBook]) // eslint-disable-line react-hooks/exhaustive-deps

  // Tap the question to hear it
  const questionAudio = useRef(null)
  useEffect(() => {
    if (!question) return
    questionAudio.current = new Audio(ttsUrl(question, cast.Narrator || 'Aoede'))
    return () => questionAudio.current.pause()
  }, [question])
  function playQuestion() {
    const audio = questionAudio.current
    audio.currentTime = 0
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
  // Read voiced lines aloud, then move on
  useEffect(() => {
    if (!voiceOf(current)) return
    narrator.src = ttsUrl(current.Dialogue, voiceOf(current))
    narrator.onended = narrator.onerror = () => lineDoneRef.current()
    if (!pausedRef.current) playNarrator()
    return () => {
      narrator.onended = narrator.onerror = null
      narrator.pause()
    }
  }, [current])

  // Voiced line's progress bar, set each frame without a re-render
  const barRef = useRef(null)
  useEffect(() => {
    if (!voiceOf(current)) return
    let frame
    const tick = () => {
      const { currentTime: t, duration: d, ended } = narrator
      if (barRef.current) barRef.current.value = ended || !Number.isFinite(d) || !d ? 0 : t / d
      const ws = wordSound.current
      if (ws?.narrated && Number.isFinite(d) && d && t / d >= ws.at) {
        wordSound.current = null
        playEffect(ws.sound, `narrated "${ws.word}" at ${Math.round(ws.at * 100)}%`)
      }
      frame = requestAnimationFrame(tick)
    }
    tick()
    return () => cancelAnimationFrame(frame)
  }, [current])

  // Pause/Play the voiced line
  useEffect(() => {
    if (!voiceOf(current)) return
    if (paused) narrator.pause()
    else if (!narrator.ended) playNarrator()
  }, [paused]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { lineRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }) }, [current, showText])

  return (
    <div className="reader">
      <div className="reader-head">
        <button type="button" className="btn btn-outline-light" onClick={leave}>To Library</button>
        <h1 className="h3 mb-0">Page {index + 1}</h1>
        <div className="reader-head-end">
          <details className="reader-sounds">
            <summary>Sounds</summary>
            <div className="reader-sounds-menu">
              <label className="form-check"><input className="form-check-input" type="checkbox" checked={modes.setting}
                onChange={(e) => setModes({ ...modes, setting: e.target.checked })} /> Page background</label>
              <fieldset>
                <legend>Line effects</legend>
                {[['off', 'Off'], ['line', 'When the line starts'], ['word', 'On the word']].map(([v, label]) => (
                  <label className="form-check" key={v}><input className="form-check-input" type="radio" name="sfx-effects"
                    checked={modes.effects === v} onChange={() => setModes({ ...modes, effects: v })} /> {label}</label>
                ))}
              </fieldset>
              <label className="form-check"><input className="form-check-input" type="checkbox" checked={modes.cues}
                onChange={(e) => setModes({ ...modes, cues: e.target.checked })} /> Cues (turn, end, see the book)</label>
            </div>
          </details>
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
              className={`reader-line${voiceOf(l) ? ' reader-narrator' : ''}${i === line && !turnWait && !finished ? ' reader-current' : ''}`}>
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
      {/* line cue */}
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
                {/* next line is the reader's */}
                {page.text[line + 1] && !voiceOf(page.text[line + 1]) && <p className="reader-cue-note">Your line is coming up.</p>}
                <progress ref={barRef} className="reader-tts" max={1} value={0} aria-label={`${current.Character} speaking`} />
              </>
            ) : <span className="reader-mic" aria-label="Your turn to read">{MicIcon}</span>}
          </div>
        )}
        {finished && <button type="button" className="btn btn-primary" onClick={leave}>Back to Library</button>}
      </div>
      {/* above the camera */}
      {pages && (
        <div className="reader-controls">
          <button type="button" aria-label="Previous page" disabled={index === 0} onClick={() => goPage(index - 1)}>{PrevPageIcon}</button>
          <button type="button" aria-label="Previous line" disabled={line === 0} onClick={prev}>{PrevIcon}</button>
          <button type="button" className="reader-play" aria-label={paused ? 'Play' : 'Pause'}
            onClick={() => setPaused(!paused)}>{paused ? PlayIcon : PauseIcon}</button>
          <button type="button" aria-label="Next line" disabled={turnWait || finished} onClick={skipLine}>{NextIcon}</button>
          <button type="button" aria-label="Next page" disabled={index === pages.length - 1} onClick={nextPage}>{NextPageIcon}</button>
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
