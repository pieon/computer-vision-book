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

// Center crop of the video frame, as drawImage source args. zoom 1.5 = the middle 2/3; zoom 1 = the whole frame.
export function crop(video, zoom = 1.5) {
  const sw = video.videoWidth / zoom
  const sh = video.videoHeight / zoom
  return [(video.videoWidth - sw) / 2, (video.videoHeight - sh) / 2, sw, sh]
}

// Full camera resolution (cropped), not the on-screen size, mirrored (the backend unwarps with flip=False).
// maxWidth/quality shrink it, e.g. for the reader's page-turn check, which the server resizes to 800px anyway.
// zoom: see crop(). Hands back { blob, url }.
export function snap(video, onPhoto, { maxWidth = Infinity, quality = 0.92, zoom = 1.5 } = {}) {
  const [sx, sy, sw, sh] = crop(video, zoom)
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

// Motion score every 100 ms: % of pixels (160px-wide crop, green channel) that changed by more than 25 since the last
// frame, over the same crop(video, zoom) a snap would take. onScore(score) gets it; returns a stop function.
export function watchMotion(video, onScore, zoom = 1.5) {
  const SMALL_W = 160
  const canvas = document.createElement('canvas')
  canvas.width = SMALL_W
  canvas.height = Math.round((SMALL_W * video.videoHeight) / video.videoWidth)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  let prev = null
  const id = setInterval(() => {
    ctx.drawImage(video, ...crop(video, zoom), 0, 0, canvas.width, canvas.height)
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
