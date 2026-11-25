// Four dots dragged to the book's corners; the server straightens photos to them. {x, y} view fractions.
export const CORNERS = [{ x: 0.2, y: 0.2 }, { x: 0.8, y: 0.2 }, { x: 0.8, y: 0.8 }, { x: 0.2, y: 0.8 }]
const NAMES = ['Top-left', 'Top-right', 'Bottom-right', 'Bottom-left']
const clamp = (v) => Math.min(Math.max(v, 0), 1)

// Rows spanned by the corners: the photo's cut band and motion area
export const cornersBand = (corners) => ({ top: Math.min(...corners.map((c) => c.y)), bottom: Math.max(...corners.map((c) => c.y)) })

export function CornerDots({ corners, setCorners, fixed }) {
  const move = (i, x, y) => setCorners((cs) => cs.map((c, k) => (k === i ? { x: clamp(x), y: clamp(y) } : c)))
  const quad = corners.map((c) => `${c.x * 100},${c.y * 100}`).join(' L')
  return (
    <>
      <svg className={`scan-quad${fixed ? ' fixed' : ''}`} viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        <path d={`M0,0 H100 V100 H0 Z M${quad} Z`} fillRule="evenodd" fill="#000a" />
        <path d={`M${quad} Z`} fill="none" vectorEffect="non-scaling-stroke" />
      </svg>
      {corners.map((c, i) => (
        <div key={NAMES[i]} className={`scan-dot${fixed ? ' fixed' : ''}`} style={{ left: `${c.x * 100}%`, top: `${c.y * 100}%` }}
          role="slider" tabIndex={fixed ? -1 : 0} aria-label={`${NAMES[i]} corner of the book`} aria-disabled={fixed}
          aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(c.y * 100)}
          aria-valuetext={`${Math.round(c.x * 100)}% across, ${Math.round(c.y * 100)}% down`}
          onPointerDown={(e) => { if (!fixed) e.currentTarget.setPointerCapture(e.pointerId) }}
          onPointerMove={(e) => {
            if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
            const view = e.currentTarget.parentElement.getBoundingClientRect() // view = frame
            move(i, (e.clientX - view.left) / view.width, (e.clientY - view.top) / view.height)
          }}
          onKeyDown={(e) => {
            const d = !fixed && { ArrowLeft: [-0.01, 0], ArrowRight: [0.01, 0], ArrowUp: [0, -0.01], ArrowDown: [0, 0.01] }[e.key]
            if (d) { e.preventDefault(); move(i, c.x + d[0], c.y + d[1]) }
          }} />
      ))}
    </>
  )
}
