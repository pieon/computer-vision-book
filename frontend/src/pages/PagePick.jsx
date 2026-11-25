import { useEffect, useRef } from 'react'

// After a decision-model turn: "which page are you on?", a swipeable row opened on its guess
export default function PagePick({ id, pages, guess, onPick }) {
  const guessRef = useRef(null)
  useEffect(() => { guessRef.current?.scrollIntoView({ inline: 'center', block: 'nearest' }) }, [])
  return (
    <div className="page-pick" role="dialog" aria-label="Which page are you on?">
      <h2 className="h4">Which page are you on?</h2>
      <p className="text-secondary">Swipe to find it, then tap it.</p>
      <div className="page-pick-row">
        {pages.map((p, i) => (
          <button type="button" key={p.key} ref={i === guess ? guessRef : null}
            className={`page-pick-item${i === guess ? ' guess' : ''}`} onClick={() => onPick(i)}>
            <img src={`/images/${id}/${p.img}`} alt="" loading="lazy" />
            <span>Page {i + 1}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
