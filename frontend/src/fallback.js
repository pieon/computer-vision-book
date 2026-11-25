// ORB first, decision model as fallback. Motion-peak sheets are candidates; if ORB can't confirm a page for
// FALLBACK_AFTER replies, the biggest-peak sheet goes to the model once.

export const FALLBACK_AFTER = 4 // unsure ORB replies before asking the model
export const ORB_SURE = 25 // inliers: ORB sees this page
export const START = { candidates: [], unsure: 0, deciding: false, done: null }

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`

// One event in: the next state, an action ({ decide } | { done }) and a log line
export function mixedStep(state, event) {
  const none = { state, action: null, log: null }
  if (state.done) return none

  if (event.type === 'sheet') {
    const candidates = [...state.candidates, { blob: event.blob, peak: event.peak, at: event.at }]
    return { state: { ...state, candidates, unsure: 0 }, action: null, log: `candidate sheet, peak ${event.peak.toFixed(1)}%` }
  }

  if (event.type === 'orb') {
    if (event.next) return { state: { ...START, done: 'orb' }, action: { done: 'orb' }, log: '→ turn: ORB sees the next page' }
    if (state.deciding) return none // waiting for the model
    if (event.current >= ORB_SURE) { // page still there: not a flip
      const kept = state.candidates.filter((c) => c.at >= event.at)
      const dropped = state.candidates.length - kept.length
      if (!dropped) return none
      return { state: { ...state, candidates: kept, unsure: 0 }, action: null,
        log: `dropped ${plural(dropped, 'sheet')} (page still there, ${event.current} inliers)` }
    }
    const latest = state.candidates.at(-1)
    if (!latest || event.at < latest.at) return none // no candidate, or an older photo
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
