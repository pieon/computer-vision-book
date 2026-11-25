import { progress } from '../scanQueue.js'

// A scanned book's preparation as one bar: each page's OCR, then its sounds and narrator clips, weighted by how long
// each takes (scanQueue.js fraction()). Nothing once the book is ready. The caller re-renders with useScanQueue().
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
