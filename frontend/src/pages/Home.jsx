import { useEffect, useRef, useState } from 'react'
import { getJson } from '../api.js'
import TabBar from '../components/TabBar.jsx'
import { unlock } from '../narrator.js'
import { unlockSounds } from '../sounds.js'

const DAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su']
const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
const dayKey = (d) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`

// This week's days, Monday first, in the device's local time.
function thisWeek() {
  const now = new Date()
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7))
  return DAYS.map((_, i) => new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i))
}

// The y-axis top: the busiest day rounded up to a whole minute (at least 1).
const niceMax = (v) => Math.max(1, Math.ceil(v))

// A simple line chart showing the user's reading time over the past week.
function ReadingChart({ minutes }) {
  const last = minutes.length - 1
  const [hover, setHover] = useState(null)
  const box = useRef(null)
  const [W, setW] = useState(350)
  useEffect(() => {
    const ro = new ResizeObserver(([entry]) => setW(entry.contentRect.width || 350))
    ro.observe(box.current)
    return () => ro.disconnect()
  }, [])
  const H = 120, TOP = 18, BOTTOM = 8
  const max = niceMax(Math.max(...minutes))
  const x = (i) => ((i + 0.5) / 7) * W
  const y = (m) => TOP + (1 - m / max) * (H - TOP - BOTTOM)
  const total = minutes.reduce((a, b) => a + b, 0)
  const pick = (e) => {
    const r = e.currentTarget.getBoundingClientRect()
    setHover(Math.min(last, Math.max(0, Math.floor(((e.clientX - r.left) / r.width) * 7))))
  }
  const onKey = (e) => {
    if (e.key === 'ArrowRight') setHover((h) => Math.min(last, (h ?? -1) + 1))
    if (e.key === 'ArrowLeft') setHover((h) => Math.max(0, (h ?? last + 1) - 1))
  }

  return (
    <div className="home-chart" ref={box}>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" tabIndex={0}
        aria-label={total ? `Reading time this week: ${Math.round(total)} minutes in total` : 'No reading time logged this week'}
        onPointerMove={pick} onPointerDown={pick} onPointerLeave={() => setHover(null)}
        onKeyDown={onKey} onFocus={() => setHover((h) => h ?? 0)} onBlur={() => setHover(null)}>
        <line className="home-grid" x1="0" x2={W} y1={y(max)} y2={y(max)} />
        <line className="home-grid" x1="0" x2={W} y1={y(0)} y2={y(0)} />
        <text className="home-axis" x="0" y={y(max) - 5}>{max} min</text>
        {hover !== null && <line className="home-crosshair" x1={x(hover)} x2={x(hover)} y1={TOP} y2={y(0)} />}
        {total > 0 && (
          <>
            <polyline className="home-line" points={minutes.map((m, i) => `${x(i)},${y(m)}`).join(' ')} />
            {minutes.map((m, i) => <circle key={i} className="home-point" cx={x(i)} cy={y(m)} r={hover === i ? 5.5 : 4} />)}
          </>
        )}
      </svg>
      {hover !== null && (
        <div className="home-tip" aria-live="polite" style={{ left: `${((hover + 0.5) / 7) * 100}%`,
          transform: hover > 3 ? 'translateX(calc(-100% - 8px))' : 'translateX(8px)' }}>{/* beside the crosshair, inward */}
          <strong>{Math.round(minutes[hover])} min</strong>
          <span>{DAY_NAMES[hover]}</span>
        </div>
      )}
      {!total && <p className="home-note">Reading time will show here once you start reading.</p>}
      <table className="visually-hidden">
        <caption>Reading minutes per day this week</caption>
        <tbody>{minutes.map((m, i) => <tr key={i}><th scope="row">{DAY_NAMES[i]}</th><td>{Math.round(m)}</td></tr>)}</tbody>
      </table>
    </div>
  )
}

// Home: this week's scanning streak, reading time, and the last book read: how much of it is read, and a tap opens it
// where reading left off with the same voices, or at Who reads? if it was finished.
export default function Home({ onHome, onLibrary, onScan, onOpenBook }) {
  const [stats, setStats] = useState(null)
  const [error, setError] = useState('')

  useEffect(() => {
    getJson('/stats')
      .then(setStats)
      .catch((e) => setError(e.message))
  }, [])

  const week = thisWeek()
  const todayKey = dayKey(new Date())
  const scanned = new Set((stats?.scans ?? []).map((t) => dayKey(new Date(t))))
  const minutes = week.slice(0, (new Date().getDay() + 6) % 7 + 1).map((d) => (stats?.reading ?? [])
    .filter((r) => dayKey(new Date(r.start)) === dayKey(d)).reduce((sum, r) => sum + r.minutes, 0))
  const scanDays = week.filter((d) => scanned.has(dayKey(d)))
  const latest = stats?.latest
  const read = latest?.read
  const unfinished = read && !read.finished
  const page = Math.min(read?.page ?? 0, (latest?.pages ?? 1) - 1) // 0-based; within the book if pages were deleted
  const pct = !read ? 0 : unfinished ? Math.round((page / latest.pages) * 100) : 100 // pages before this one are read
  function open() {
    unlock() // Safari plays narration and sounds only after a tap: this one, when Who reads? is skipped
    unlockSounds()
    onOpenBook(unfinished ? { id: latest.id, cast: read.cast, page: read.page } : { id: latest.id, cast: null, page: 0 })
  }

  return (
    <div className="home">
      <h1 className="home-title">Home</h1>
      {error && <div className="alert alert-danger">Couldn't load your stats: {error}</div>}

      <section className="home-card" aria-labelledby="home-week">
        <h2 id="home-week">This week</h2>
        <p className="home-sub">
          {stats ? `Scanned on ${scanDays.length} day${scanDays.length === 1 ? '' : 's'}` : 'Loading...'}
        </p>
        <ol className="home-days" aria-label="Days with scans this week">
          {week.map((d, i) => {
            const on = scanned.has(dayKey(d))
            return (
              <li key={i} className={dayKey(d) === todayKey ? 'home-today' : undefined}>
                <span className={on ? 'home-dot home-dot-on' : 'home-dot'} aria-hidden="true" />
                <span aria-hidden="true">{DAYS[i]}</span>
                <span className="visually-hidden">{DAY_NAMES[i]}: {on ? 'scanned' : 'no scans'}</span>
              </li>
            )
          })}
        </ol>
        <h3 className="home-sub home-sub-chart">Reading time</h3>
        <ReadingChart minutes={minutes} />
      </section>

      {stats && (
        <section className="home-card" aria-labelledby="home-latest">
          <h2 id="home-latest">Last Read Book</h2>
          {latest ? (
            <>
              <button type="button" className="home-open" onClick={open}>
                <span className="home-book">{latest.name}</span>
                <span className="home-sub">{unfinished ? 'Pick up where you left off' : 'Read again'} ›</span>
              </button>
              <p className="home-sub"><strong>{pct}%</strong> · {unfinished ? `Page ${page + 1} of ${latest.pages}` : 'Finished'}</p>
              <div className="home-meter" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}
                aria-label="How much of the book is read">
                <span style={{ width: `${pct}%` }} />
              </div>
            </>
          ) : (
            <p className="home-sub">No last read book.</p>
          )}
        </section>
      )}

      <TabBar active="home" onHome={onHome} onLibrary={onLibrary} onScan={onScan} />
    </div>
  )
}
