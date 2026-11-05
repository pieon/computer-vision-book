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

// Center crop of the video frame, as drawImage source args.
export function crop(video) {
  const sw = video.videoWidth / 1.5
  const sh = video.videoHeight / 1.5
  return [(video.videoWidth - sw) / 2, (video.videoHeight - sh) / 2, sw, sh]
}

// Full camera resolution (cropped), not the on-screen size, mirrored (the backend unwarps with flip=False).
// Hands back { blob, url }.
export function snap(video, onPhoto) {
  const [sx, sy, sw, sh] = crop(video)
  const canvas = document.createElement('canvas')
  canvas.width = sw
  canvas.height = sh
  const ctx = canvas.getContext('2d')
  ctx.translate(sw, 0)
  ctx.scale(-1, 1)
  ctx.drawImage(video, sx, sy, sw, sh, 0, 0, sw, sh)
  canvas.toBlob((blob) => blob && onPhoto({ blob, url: URL.createObjectURL(blob) }), 'image/jpeg', 0.92)
}

// Motion score every 100 ms: % of pixels (160px-wide crop, green channel) that changed by more than 25 since the last
// frame. onScore(score) gets it; returns a stop function.
export function watchMotion(video, onScore) {
  const SMALL_W = 160
  const canvas = document.createElement('canvas')
  canvas.width = SMALL_W
  canvas.height = Math.round((SMALL_W * video.videoHeight) / video.videoWidth)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  let prev = null
  const id = setInterval(() => {
    ctx.drawImage(video, ...crop(video), 0, 0, canvas.width, canvas.height)
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
