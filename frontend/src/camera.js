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
