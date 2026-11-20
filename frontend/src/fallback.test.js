import { expect, test } from 'vitest'
import { FALLBACK_AFTER, mixedStep, START } from './fallback.js'

// Feed events in order; returns the last result and every action taken.
function run(events, state = START) {
  const actions = []
  let r = { state }
  for (const e of events) {
    r = mixedStep(r.state, e)
    if (r.action) actions.push(r.action)
  }
  return { ...r, actions }
}
const sheet = (peak, at, blob = `sheet${peak}`) => ({ type: 'sheet', blob, peak, at })
const orb = (at, current = 5, next = false) => ({ type: 'orb', next, current, at })
const unsure = (from, n = FALLBACK_AFTER) => Array.from({ length: n }, (_, i) => orb(from + i))

test('a motion followed by the page still being there is dropped: no call', () => {
  const r = run([sheet(30, 100), orb(200, 60), ...unsure(300)])
  expect(r.state.candidates).toEqual([])
  expect(r.actions).toEqual([])
})

test('ORB unsure for FALLBACK_AFTER replies after a sheet: one call, with the biggest peak', () => {
  const r = run([sheet(12, 100), sheet(34, 150), ...unsure(200)])
  expect(r.actions).toEqual([{ decide: { blob: 'sheet34', peak: 34, at: 150 } }])
  expect(r.state.deciding).toBe(true)
})

test('one reply short of FALLBACK_AFTER: no call yet', () => {
  expect(run([sheet(30, 100), ...unsure(200, FALLBACK_AFTER - 1)]).actions).toEqual([])
})

test('no second call while one is in flight', () => {
  const r = run([sheet(30, 100), ...unsure(200), ...unsure(300)])
  expect(r.actions.filter((a) => a.decide)).toHaveLength(1)
})

test('ORB sees the next page first: done by ORB, no call', () => {
  const r = run([sheet(30, 100), orb(200), orb(210, 0, true), ...unsure(300)])
  expect(r.actions).toEqual([{ done: 'orb' }])
  expect(r.state.done).toBe('orb')
})

test('ORB seeing the next page still wins while the model is deciding', () => {
  const r = run([sheet(30, 100), ...unsure(200), orb(400, 0, true)])
  expect(r.actions.at(-1)).toEqual({ done: 'orb' })
})

test('the model says page_turn: done by the decision model', () => {
  const r = run([sheet(30, 100), ...unsure(200), { type: 'decision', turned: true, p: 0.9 }])
  expect(r.actions.at(-1)).toEqual({ done: 'decision' })
})

test('the model says no_turn: start over, waiting for the next motion', () => {
  const r = run([sheet(30, 100), ...unsure(200), { type: 'decision', turned: false, choice: 'no_turn', p: 0.8 }])
  expect(r.state).toEqual(START)
  expect(run([...unsure(300)], r.state).actions).toEqual([]) // no candidate: nothing to ask about
})

test('photos taken before a motion say nothing about it', () => {
  const kept = run([sheet(30, 500), orb(400, 60)]) // still-page photo from before the peak: sheet kept
  expect(kept.state.candidates).toHaveLength(1)
  expect(run([sheet(30, 500), ...unsure(100)]).actions).toEqual([]) // unsure photos from before it: not counted
})

test('no sheet yet: unsure ORB replies alone never call the model', () => {
  expect(run(unsure(100, 10)).actions).toEqual([])
})
