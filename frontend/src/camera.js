// Open the camera (and mic, if `constraints` asks) into `video` and play it. Returns a stop function right away,
// so it fits as a useEffect cleanup. onReady(stream) runs once the video is playing; onError(e) if it can't start
// (NotAllowedError = permission denied; also fails on plain http:// other than localhost). Neither runs after stop.
export function startCamera(video, constraints, onReady, onError) {
  let stream
  let stopped = false
  const stop = () => {
    stopped = true
    stream?.getTracks().forEach((t) => t.stop())
  }
  navigator.mediaDevices
    .getUserMedia(constraints)
    .then(async (s) => {
      stream = s
      if (stopped) return stop() // left the screen while the permission prompt was open
      video.srcObject = s
      await video.play()
      if (!stopped) onReady(s)
    })
    .catch((e) => { if (!stopped) onError(e) })
  return stop
}

// The part of a video frame or <img> inside `band`, as drawImage source args: full width, the rows from band.top to
// band.bottom (fractions of the height; the setup lines, BandLine.jsx). The default band is the whole frame.
export const FULL = { top: 0, bottom: 1 }
export function crop(source, band = FULL) {
  const width = source.videoWidth ?? source.naturalWidth
  const height = source.videoHeight ?? source.naturalHeight
  const y = Math.round(band.top * height) // whole pixel rows
  return [0, y, width, Math.round(band.bottom * height) - y]
}

// An already-taken photo (an <img> of a snap(): mirrored already, so not again) cut to `band`, as a JPEG blob for
// onBlob: what snap(video, ..., { band }) would have sent.
export function cropImage(img, band, onBlob, { quality = 0.92 } = {}) {
  const [sx, sy, sw, sh] = crop(img, band)
  const canvas = document.createElement('canvas')
  canvas.width = sw
  canvas.height = sh
  canvas.getContext('2d').drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh)
  canvas.toBlob((blob) => blob && onBlob(blob), 'image/jpeg', quality)
}

// Full camera resolution (cropped to `band`, see crop()), not the on-screen size, mirrored (the backend unwarps with
// flip=False). maxWidth/quality shrink it, e.g. for the reader's page-turn check, which the server resizes to 800px
// anyway. Hands back { blob, url }.
export function snap(video, onPhoto, { maxWidth = Infinity, quality = 0.92, band = FULL } = {}) {
  const [sx, sy, sw, sh] = crop(video, band)
  const scale = Math.min(1, maxWidth / sw)
  const w = Math.round(sw * scale)
  const h = Math.round(sh * scale)
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  ctx.translate(w, 0)
  ctx.scale(-1, 1)
  ctx.drawImage(video, sx, sy, sw, sh, 0, 0, w, h)
  canvas.toBlob((blob) => blob && onPhoto({ blob, url: URL.createObjectURL(blob) }), 'image/jpeg', quality)
}

// Full frame, mirrored like snap(), drawn at (x, y) in a w x h box.
function drawMirrored(ctx, video, x, y, w, h) {
  ctx.save()
  ctx.translate(x + w, y)
  ctx.scale(-1, 1)
  ctx.drawImage(video, ...crop(video), 0, 0, w, h)
  ctx.restore()
}

// Frame number n in the tile's top-left corner, so the model (and you) can read the time order.
function numberTile(ctx, x, y, n) {
  ctx.fillStyle = '#000'
  ctx.fillRect(x, y, 32, 26)
  ctx.fillStyle = '#fff'
  ctx.fillText(String(n), x + 5, y + 20)
}

// Zoetrope-style sheet for the decision model's page-turn check: `frames` full-frame shots `gapMs` apart, mirrored like
// snap(), drawn into a `cols`-wide grid in time order (left to right, then the next row), each numbered 1..frames in
// its corner. onSheet({ blob, ms }) gets the JPEG and how long capturing took; returns a stop function.
export function frameSheet(video, onSheet, { frames = 10, gapMs = 150, cols = 5, w = 320 } = {}) {
  const h = Math.round((w * video.videoHeight) / video.videoWidth)
  const canvas = document.createElement('canvas')
  canvas.width = cols * w
  canvas.height = Math.ceil(frames / cols) * h
  const ctx = canvas.getContext('2d')
  ctx.font = 'bold 20px sans-serif'
  const startAt = performance.now()
  let i = 0
  const timer = setInterval(() => {
    const x = (i % cols) * w
    const y = Math.floor(i / cols) * h
    drawMirrored(ctx, video, x, y, w, h)
    numberTile(ctx, x, y, i + 1)
    if (++i < frames) return
    clearInterval(timer)
    const ms = performance.now() - startAt
    canvas.toBlob((blob) => blob && onSheet({ blob, ms }), 'image/jpeg', 0.8)
  }, gapMs)
  return () => clearInterval(timer)
}

// Which buffered frames make a sheet around time `at`: indices of the last `before` frames taken at or before `at`
// and the first `after` frames taken after it (`times` oldest first). Fewer before-frames if the buffer doesn't reach
// back that far; null until `after` frames after `at` exist.
export function pickFrames(times, at, before, after) {
  const first = times.findIndex((t) => t > at) // first frame after `at`
  if (first < 0 || times.length - first < after) return null
  const from = Math.max(0, first - before)
  return Array.from({ length: first + after - from }, (_, k) => from + k)
}

// Rolling buffer for zoetrope sheets: a full, mirrored frame every `gapMs`, the last `keep` of them kept (20 x 150 ms
// = 3 s). sheet(at, before, after, onSheet) asks for a sheet around time `at` (performance.now()): once `after`
// frames after it exist, the frames around it are drawn into the same numbered 5-wide grid as frameSheet and
// onSheet({ blob }) gets the JPEG. stop(): no new sheets; capturing ends once the asked-for ones are done, so a flip
// that just turned the page is still saved.
export function frameBuffer(video, { keep = 20, gapMs = 150, cols = 5, w = 320 } = {}) {
  const h = Math.round((w * video.videoHeight) / video.videoWidth)
  const frames = [] // { t, canvas }, oldest first; canvases are reused once the buffer is full
  let pending = [] // { at, before, after, onSheet }
  let stopped = false

  function compose(tiles, onSheet) {
    const canvas = document.createElement('canvas')
    canvas.width = cols * w
    canvas.height = Math.ceil(tiles.length / cols) * h
    const ctx = canvas.getContext('2d')
    ctx.font = 'bold 20px sans-serif'
    tiles.forEach((tile, i) => {
      const x = (i % cols) * w
      const y = Math.floor(i / cols) * h
      ctx.drawImage(tile, x, y) // already mirrored
      numberTile(ctx, x, y, i + 1)
    })
    canvas.toBlob((blob) => blob && onSheet({ blob }), 'image/jpeg', 0.8)
  }

  const timer = setInterval(() => {
    if (stopped && !pending.length) return clearInterval(timer)
    const canvas = frames.length >= keep ? frames.shift().canvas : Object.assign(document.createElement('canvas'), { width: w, height: h })
    drawMirrored(canvas.getContext('2d'), video, 0, 0, w, h)
    frames.push({ t: performance.now(), canvas })
    const times = frames.map((f) => f.t)
    pending = pending.filter((p) => {
      const picked = pickFrames(times, p.at, p.before, p.after)
      if (picked) compose(picked.map((i) => frames[i].canvas), p.onSheet) // drawn now, before the canvases are reused
      return !picked
    })
  }, gapMs)

  return {
    sheet(at, before, after, onSheet) { if (!stopped) pending.push({ at, before, after, onSheet }) },
    stop() { stopped = true },
  }
}

// Motion score every 100 ms: % of pixels (160px-wide, green channel) that changed by more than 25 since the last
// frame, over the same crop(video, band) a snap would take, so movement outside the book doesn't count.
// onScore(score) gets it; returns a stop function.
export function watchMotion(video, onScore, band = FULL) {
  const SMALL_W = 160
  const canvas = document.createElement('canvas')
  canvas.width = SMALL_W
  canvas.height = Math.max(1, Math.round((SMALL_W * video.videoHeight * (band.bottom - band.top)) / video.videoWidth))
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  let prev = null
  const id = setInterval(() => {
    ctx.drawImage(video, ...crop(video, band), 0, 0, canvas.width, canvas.height)
    const cur = ctx.getImageData(0, 0, canvas.width, canvas.height).data
    if (prev) {
      let changed = 0
      for (let i = 1; i < cur.length; i += 4) if (Math.abs(cur[i] - prev[i]) > 25) changed++
      onScore((changed / (cur.length / 4)) * 100)
    }
    prev = cur
  }, 100)
  return () => clearInterval(id)
}
