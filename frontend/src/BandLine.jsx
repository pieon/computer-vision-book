// Two draggable lines at the top and bottom of the book; outside is shaded and cut off
export const BAND = { top: 0.2, bottom: 0.8 } // fractions of the view's height
export const MIN_GAP = 0.1 // minimum gap

// One line: drag it (or arrow keys, 1% a step); can't cross the other
export function BandLine({ which, band, setBand, fixed }) {
  const value = band[which]
  const set = (v) => setBand((b) => (which === 'top'
    ? { ...b, top: Math.min(Math.max(v, 0), b.bottom - MIN_GAP) }
    : { ...b, bottom: Math.max(Math.min(v, 1), b.top + MIN_GAP) }))
  return (
    <div className={`scan-line${fixed ? ' fixed' : ''}`} style={{ top: `${value * 100}%` }}
      role="slider" tabIndex={fixed ? -1 : 0} aria-label={`${which === 'top' ? 'Top' : 'Bottom'} of the book`}
      aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(value * 100)} aria-disabled={fixed}
      onPointerDown={(e) => { if (!fixed) e.currentTarget.setPointerCapture(e.pointerId) }}
      onPointerMove={(e) => {
        if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
        const view = e.currentTarget.parentElement.getBoundingClientRect() // view height = frame height
        set((e.clientY - view.top) / view.height)
      }}
      onKeyDown={(e) => {
        const d = !fixed && { ArrowUp: -0.01, ArrowDown: 0.01 }[e.key]
        if (d) { e.preventDefault(); set(value + d) }
      }} />
  )
}
