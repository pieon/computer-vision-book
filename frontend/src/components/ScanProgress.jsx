import { progress } from '../scanQueue.js'

// A scanned book's preparation as one bar (scanQueue.js fraction()); nothing once ready
export default function ScanProgress({ id }) {
  const p = progress(id)
  if (!p || p.ready) return null
  const pct = Math.floor(p.fraction * 100)
  return (
    <div className="scan-progress" role="status">
      <progress max="100" value={pct} aria-label="Preparing the book" />
      <span>Preparing · {pct}%{p.failed > 0 && <span className="scan-progress-failed"> · {p.failed} failed</span>}</span>
    </div>
  )
}
