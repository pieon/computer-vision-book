// Sound effects during reading (picked per page at scan time: backend/pipeline/book/sounds.py). Played with Web Audio,
// not <audio>: iPad Safari ignores audio.volume, and the background loop must stay quiet under the narration. Files
// come from our own server (/sounds/file/<id>.mp3), so Web Audio may play them. unlockSounds() must run on a tap
// (Cast's Start), like narrator.js unlock().

// Which ways of playing them are on, to compare them (the reader's Sounds menu); kept per device.
// effects: when a line's effect plays: 'off', 'line' (the line starts) or 'word' (its word is said)
export const NO_SOUNDS = { setting: false, effects: 'off', cues: false }
export function loadModes() {
  try { return { ...NO_SOUNDS, ...JSON.parse(localStorage.getItem('soundModes')) } } catch { return NO_SOUNDS }
}
export function saveModes(modes) {
  try { localStorage.setItem('soundModes', JSON.stringify(modes)) } catch { /* private mode: not remembered */ }
}

// Background loop volume, after levelling (loudness()): recordings range from near-silent room tone to loud traffic,
// so each is first brought to the same loudness. Tune these two by ear.
const LOOP = 0.5
const LOOP_DUCKED = 0.2 // while the child reads: quieter for them and the mic
const LOOP_RMS = 0.1 // the loudness every loop is levelled to (RMS of the samples, 1 = full scale)
const MAX_BOOST = 12 // a near-silent recording isn't raised more than this, so its hiss doesn't become a roar
const EFFECT = 0.6
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
// Fetch and decode ahead (a page's sounds when it opens), so an effect on a word isn't late
export const preload = (list) => list.forEach((s) => s && load(s).catch(() => {}))

// Sounds played this reading, for the credits (Freesound: credit each creator per the sound's licence)
export const played = new Map()

// RMS of the first channel, every 50th sample (enough for a loudness estimate)
function loudness(buffer) {
  const data = buffer.getChannelData(0)
  let sum = 0
  let n = 0
  for (let i = 0; i < data.length; i += 50, n++) sum += data[i] * data[i]
  return Math.sqrt(sum / Math.max(n, 1)) || 1e-4
}

function start(sound, volume, loop) {
  const gain = ctx.createGain()
  gain.gain.value = volume
  gain.connect(ctx.destination)
  return load(sound).then((buffer) => {
    const src = ctx.createBufferSource()
    src.buffer = buffer
    src.loop = loop
    src.connect(gain)
    src.start()
    played.set(sound.id, sound)
    return { src, gain, level: loop ? Math.min(MAX_BOOST, LOOP_RMS / loudness(buffer)) : 1 }
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
// The page's background loop; null stops it. The same sound keeps playing; another one fades over.
export function setLoop(sound) {
  if (loop?.sound.id === sound?.id) return
  loop?.playing.then(fadeOut, () => {})
  loop = null
  if (!sound) return
  console.log(`[sfx] loop ${sound.keyword}`)
  const playing = start(sound, 0, true)
  playing.then(({ gain, level }) => gain.gain.setTargetAtTime((ducked ? LOOP_DUCKED : LOOP) * level, ctx.currentTime, FADE / 3),
    (e) => console.log(`[sfx] loop ${sound.keyword} failed:`, e))
  loop = { sound, playing }
}
// Quieter while the child reads
export function duck(on) {
  ducked = on
  loop?.playing.then(({ gain, level }) => gain.gain.setTargetAtTime((on ? LOOP_DUCKED : LOOP) * level, ctx.currentTime, 0.1), () => {})
}
export function stopAll() {
  setLoop(null)
  effects.forEach(({ src }) => src.stop())
  effects.clear()
}
