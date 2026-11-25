// Reading sound effects via Web Audio (iPad ignores audio.volume). unlockSounds() must run on a tap.

// Sound modes (Sounds menu), kept per device; effects: 'off' | 'line' | 'word'
export const NO_SOUNDS = { setting: false, effects: 'off', cues: false }
export function loadModes() {
  try { return { ...NO_SOUNDS, ...JSON.parse(localStorage.getItem('soundModes')) } } catch { return NO_SOUNDS }
}
export function saveModes(modes) {
  try { localStorage.setItem('soundModes', JSON.stringify(modes)) } catch { /* private mode: not remembered */ }
}

// Target loudness (RMS) per kind; voices are about 0.2. Tune by ear.
const EFFECT = 0.1 // about half the voice
const LOOP = 0.04 // a fifth of the voice
const LOOP_DUCKED = 0.015 // while the child reads: quieter for them and the mic
const MAX_BOOST = 12 // cap, so hiss isn't boosted
const FADE = 0.5 // s

const ctx = new (window.AudioContext || window.webkitAudioContext)()
export const unlockSounds = () => ctx.resume().catch(() => {})

const buffers = new Map() // sound id -> Promise<AudioBuffer>
function load(sound) {
  if (!buffers.has(sound.id)) {
    buffers.set(sound.id, fetch(`/sounds/file/${sound.id}.mp3`)
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.arrayBuffer() })
      .then((b) => ctx.decodeAudioData(b))
      .catch((e) => { buffers.delete(sound.id); throw e })) // retried next time
  }
  return buffers.get(sound.id)
}
// Fetch and decode ahead
export const preload = (list) => list.forEach((s) => s && load(s).catch(() => {}))

// Loudness: RMS of the loudest fifth of 50 ms windows, plus the peak
function loudness(buffer) {
  const data = buffer.getChannelData(0)
  const size = Math.max(1, Math.round(buffer.sampleRate * 0.05))
  const windows = []
  let peak = 0
  for (let at = 0; at < data.length; at += size) {
    let sum = 0
    let n = 0
    for (let i = at; i < Math.min(at + size, data.length); i += 4, n++) {
      sum += data[i] * data[i]
      peak = Math.max(peak, Math.abs(data[i]))
    }
    windows.push(sum / Math.max(n, 1))
  }
  windows.sort((a, b) => b - a)
  const top = windows.slice(0, Math.max(1, Math.ceil(windows.length / 5)))
  return { rms: Math.sqrt(top.reduce((a, b) => a + b, 0) / top.length) || 1e-4, peak: peak || 1e-4 }
}

// Play `sound` levelled to `target` (capped by MAX_BOOST and the peak). Resolves to { src, gain, full }.
function start(sound, target, loop, fadeIn = false) {
  const gain = ctx.createGain()
  gain.gain.value = 0
  gain.connect(ctx.destination)
  return load(sound).then((buffer) => {
    const { rms, peak } = loudness(buffer)
    const full = Math.min(MAX_BOOST, target / rms, 1 / peak)
    if (!fadeIn) gain.gain.value = full
    const src = ctx.createBufferSource()
    src.buffer = buffer
    src.loop = loop
    src.connect(gain)
    src.start()
    return { src, gain, full }
  })
}

const effects = new Set()
export function playEffect(sound, why) {
  if (!sound) return
  console.log(`[sfx] ${sound.keyword} (${why})`)
  start(sound, EFFECT, false)
    .then((e) => { effects.add(e); e.src.onended = () => effects.delete(e) })
    .catch((e) => console.log(`[sfx] ${sound.keyword} failed:`, e))
}

let loop = null // { sound, playing: Promise<{src, gain}> }
let ducked = false
function fadeOut({ src, gain }) {
  gain.gain.setTargetAtTime(0, ctx.currentTime, FADE / 3)
  src.stop(ctx.currentTime + FADE)
}
// Page background loop; null stops it, a new one crossfades
export function setLoop(sound) {
  if (loop?.sound.id === sound?.id) return
  loop?.playing.then(fadeOut, () => {})
  loop = null
  if (!sound) return
  console.log(`[sfx] loop ${sound.keyword}`)
  const playing = start(sound, LOOP, true, true)
  playing.then(({ gain, full }) => gain.gain.setTargetAtTime(ducked ? full * LOOP_DUCKED / LOOP : full, ctx.currentTime, FADE / 3),
    (e) => console.log(`[sfx] loop ${sound.keyword} failed:`, e))
  loop = { sound, playing }
}
// Quieter while the child reads
export function duck(on) {
  ducked = on
  loop?.playing.then(({ gain, full }) => gain.gain.setTargetAtTime(on ? full * LOOP_DUCKED / LOOP : full, ctx.currentTime, 0.1), () => {})
}
export function stopAll() {
  setLoop(null)
  effects.forEach(({ src }) => src.stop())
  effects.clear()
}
