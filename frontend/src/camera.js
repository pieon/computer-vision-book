// Start the camera (and mic) into `video`. Returns stop; onReady(stream) / onError(e).
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
      if (stopped) return stop() // left during the permission prompt
      video.srcObject = s
      await video.play()
      if (!stopped) onReady(s)
    })
    .catch((e) => { if (!stopped) onError(e) })
  return stop
}

// drawImage source args for the rows of `band` (fractions of the height)
export const FULL = { top: 0, bottom: 1 }
export function crop(source, band = FULL) {
  const width = source.videoWidth ?? source.naturalWidth
  const height = source.videoHeight ?? source.naturalHeight
  const y = Math.round(band.top * height)
  return [0, y, width, Math.round(band.bottom * height) - y]
}

// An already-taken photo cut to `band`, as a JPEG blob
export function cropImage(img, band, onBlob, { quality = 0.92 } = {}) {
  const [sx, sy, sw, sh] = crop(img, band)
  const canvas = document.createElement('canvas')
  canvas.width = sw
  canvas.height = sh
  canvas.getContext('2d').drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh)
  canvas.toBlob((blob) => blob && onBlob(blob), 'image/jpeg', quality)
}

// Full-resolution photo cut to `band`, mirrored (front camera), turned `turn` degrees clockwise. Hands back { blob, url }.
export function snap(video, onPhoto, { maxWidth = Infinity, quality = 0.92, band = FULL, mirror = true, turn = 0 } = {}) {
  const [sx, sy, sw, sh] = crop(video, band)
  const scale = Math.min(1, maxWidth / sw)
  const w = Math.round(sw * scale)
  const h = Math.round(sh * scale)
  const sideways = turn % 180 !== 0
  const canvas = document.createElement('canvas')
  canvas.width = sideways ? h : w
  canvas.height = sideways ? w : h
  const ctx = canvas.getContext('2d')
  ctx.translate(canvas.width / 2, canvas.height / 2) // turn and mirror about the centre
  ctx.rotate((turn * Math.PI) / 180)
  if (mirror) ctx.scale(-1, 1)
  ctx.drawImage(video, sx, sy, sw, sh, -w / 2, -h / 2, w, h)
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

// Frame number in the tile's corner
function numberTile(ctx, x, y, n) {
  ctx.fillStyle = '#000'
  ctx.fillRect(x, y, 32, 26)
  ctx.fillStyle = '#fff'
  ctx.fillText(String(n), x + 5, y + 20)
}

// Numbered frame sheet for the decision model: `frames` shots `gapMs` apart. onSheet({ blob, ms }); returns stop.
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

// Indices of `before` frames up to `at` and `after` frames after it; null until enough exist
export function pickFrames(times, at, before, after) {
  const first = times.findIndex((t) => t > at)
  if (first < 0 || times.length - first < after) return null
  const from = Math.max(0, first - before)
  return Array.from({ length: first + after - from }, (_, k) => from + k)
}

// Rolling frame buffer: sheet(at, before, after, onSheet) builds a sheet around `at`; stop() still finishes pending sheets.
export function frameBuffer(video, { keep = 20, gapMs = 150, cols = 5, w = 320 } = {}) {
  const h = Math.round((w * video.videoHeight) / video.videoWidth)
  const frames = [] // { t, canvas }, oldest first
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
      if (picked) compose(picked.map((i) => frames[i].canvas), p.onSheet) // before canvases are reused
      return !picked
    })
  }, gapMs)

  return {
    sheet(at, before, after, onSheet) { if (!stopped) pending.push({ at, before, after, onSheet }) },
    stop() { stopped = true },
  }
}

// Motion score every 100 ms: % of changed pixels inside `band`. Returns stop.
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
