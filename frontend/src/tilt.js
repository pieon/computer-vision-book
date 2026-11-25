// Which way to turn a back-camera photo so the book is upright (Scanner): a phone may be held sideways over the book
// with the screen not turning with it (rotation lock), or laid flat after being turned. Camera frames come in the
// screen's orientation, so the photo needs turning by how far the device is turned from the screen.

const FLAT = 0.35 // below this much sideways gravity (1 = upright) the device is too flat to tell its rotation

// Degrees clockwise (0, 90, 180, 270) to turn a photo, from deviceorientation beta / gamma (degrees) and
// screen.orientation.angle (degrees counter-clockwise, as browsers report it); null when the device is too flat to
// tell, so the caller keeps its last reading.
export function turnFor(beta, gamma, screenAngle = 0) {
  const b = (beta * Math.PI) / 180
  const g = (gamma * Math.PI) / 180
  const gx = Math.cos(b) * Math.sin(g) // gravity in device coordinates: x to the right edge, y to the top edge
  const gy = -Math.sin(b)
  if (Math.hypot(gx, gy) < FLAT) return null
  const device = (Math.round((Math.atan2(gx, -gy) * 180) / Math.PI / 90) * 90 + 360) % 360 // clockwise from upright
  const screen = (360 - (Math.round(screenAngle / 90) * 90) % 360) % 360
  return (device - screen + 360) % 360
}

// Ask for motion access (iOS: only from a tap; elsewhere there's nothing to ask). Resolves true if allowed.
export function requestTurn() {
  const ask = window.DeviceOrientationEvent?.requestPermission
  if (!ask) return Promise.resolve(true)
  return ask().then((r) => r === 'granted', () => false)
}

// Call onTurn(degrees) whenever the turn a photo needs changes; flat readings are skipped. Returns a stop function.
export function watchTurn(onTurn) {
  let last = null
  const on = (e) => {
    if (e.beta === null || e.gamma === null) return
    const t = turnFor(e.beta, e.gamma, screen.orientation?.angle ?? window.orientation ?? 0)
    if (t !== null && t !== last) onTurn((last = t))
  }
  window.addEventListener('deviceorientation', on)
  return () => window.removeEventListener('deviceorientation', on)
}
