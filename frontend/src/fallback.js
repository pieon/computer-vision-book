// ORB first, decision model as fallback: Book.jsx TURN_CHECK 'mixed' turns pages with it; beside 'decision' it can
// also run logged-only (SHADOW_MIXED).
// Sheets from motion peaks are candidates. An ORB reply that still clearly sees the current page drops them (that
// motion wasn't a flip). If ORB can't confirm either page for FALLBACK_AFTER replies after a candidate, the candidate
// with the biggest peak goes to the decision model, once. ORB seeing the next page, or the model saying page_turn,
// ends it for this page.
// Times are performance.now(): a sheet's `at` is its motion peak, an ORB reply's `at` is when its photo was taken, so a
// reply whose photo was taken before a peak says nothing about that peak's sheet.

export const FALLBACK_AFTER = 4 // ORB replies that confirm neither page, after a candidate, before asking the model
export const ORB_SURE = 25 // inliers: ORB sees this page (the same cutoff /turn uses to turn)
export const START = { candidates: [], unsure: 0, deciding: false, done: null }

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`

// One event in, the next state out, plus what to do and a console message (null when there's nothing to say).
// Events: { type: 'sheet', blob, peak, at } | { type: 'orb', next, current, at } | { type: 'decision', turned, choice, p, error }
// Actions: null | { decide: candidate } | { done: 'orb' | 'decision' }
export function mixedStep(state, event) {
  const none = { state, action: null, log: null }
  if (state.done) return none

  if (event.type === 'sheet') {
    const candidates = [...state.candidates, { blob: event.blob, peak: event.peak, at: event.at }]
    return { state: { ...state, candidates, unsure: 0 }, action: null, log: `candidate sheet, peak ${event.peak.toFixed(1)}%` }
  }

  if (event.type === 'orb') {
    if (event.next) return { state: { ...START, done: 'orb' }, action: { done: 'orb' }, log: '→ turn: ORB sees the next page' }
    if (state.deciding) return none // waiting for the model; only ORB seeing the next page still counts
    if (event.current >= ORB_SURE) { // the page is still there: motions before this photo weren't flips
      const kept = state.candidates.filter((c) => c.at >= event.at)
      const dropped = state.candidates.length - kept.length
      if (!dropped) return none
      return { state: { ...state, candidates: kept, unsure: 0 }, action: null,
        log: `dropped ${plural(dropped, 'sheet')} (page still there, ${event.current} inliers)` }
    }
    const latest = state.candidates.at(-1)
    if (!latest || event.at < latest.at) return none // nothing to ask about, or a photo from before that motion
    const unsure = state.unsure + 1
    if (unsure < FALLBACK_AFTER) return { state: { ...state, unsure }, action: null, log: `ORB unsure ${unsure}/${FALLBACK_AFTER}` }
    const best = state.candidates.reduce((a, b) => (b.peak > a.peak ? b : a))
    return { state: { ...state, unsure, deciding: true }, action: { decide: best },
      log: `fallback → sending the peak ${best.peak.toFixed(1)}% sheet to the decision model` }
  }

  if (event.type === 'decision') {
    if (event.turned) {
      return { state: { ...START, done: 'decision' }, action: { done: 'decision' }, log: `→ turn: decision model says page_turn (p ${event.p})` }
    }
    const said = event.error ? `failed: ${event.error}`
      : `said ${event.choice} (p ${event.p})${event.choice === 'page_turn' ? ', below the cutoff (turn.py TURN_P)' : ''}`
    return { state: { ...START }, action: null, log: `decision ${said}; waiting for the next motion` }
  }
  return none
}
