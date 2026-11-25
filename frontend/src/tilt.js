// How far to turn a back-camera photo so the book is upright, from the device's tilt

const FLAT = 0.35 // sideways gravity below this: too flat to tell

// Degrees clockwise to turn a photo, from beta / gamma and the screen angle; null when too flat
export function turnFor(beta, gamma, screenAngle = 0) {
  const b = (beta * Math.PI) / 180
  const g = (gamma * Math.PI) / 180
  const gx = Math.cos(b) * Math.sin(g) // gravity in device coordinates
  const gy = -Math.sin(b)
  if (Math.hypot(gx, gy) < FLAT) return null
  const device = (Math.round((Math.atan2(gx, -gy) * 180) / Math.PI / 90) * 90 + 360) % 360 // clockwise from upright
  const screen = (360 - (Math.round(screenAngle / 90) * 90) % 360) % 360
  return (device - screen + 360) % 360
}

// Ask for motion access (iOS: only from a tap). Resolves true if allowed.
export function requestTurn() {
  const ask = window.DeviceOrientationEvent?.requestPermission
  if (!ask) return Promise.resolve(true)
  return ask().then((r) => r === 'granted', () => false)
}

// onTurn(degrees) when the needed turn changes. Returns stop.
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
