import { expect, test, vi } from 'vitest'
import { cancel, enqueue, MAX_IN_FLIGHT, progress, scanning } from './scanQueue.js'

// fetch that answers after `ms`; `fail(n, attempt)` says whether that call fails. Records calls and peak concurrency.
function fakeFetch(ms, fail = () => false) {
  const calls = []
  const stats = { inFlight: 0, peak: 0 }
  globalThis.fetch = vi.fn(async (url) => {
    const n = Number(new URL(url, 'http://x').searchParams.get('n'))
    const attempt = calls.filter((c) => c === n).length + 1
    calls.push(n)
    stats.peak = Math.max(stats.peak, ++stats.inFlight)
    await new Promise((r) => setTimeout(r, ms))
    stats.inFlight--
    if (fail(n, attempt)) return { ok: false, status: 500 }
    return { ok: true, status: 200, json: async () => ({ page: `page ${n}`, times: {} }) }
  })
  return { calls, stats }
}

test('sends right away, several at once, each with its own page number', async () => {
  const { calls, stats } = fakeFetch(20, (n, attempt) => (n === 1 && attempt === 1) || n === 2) // 1: retried; 2: fails twice
  const results = {}
  for (let n = 0; n < 6; n++) enqueue('bookA', n, `photo${n}`, (reply) => { results[n] = reply ? 'ok' : 'failed' })
  expect(calls).toEqual([0, 1, 2, 3]) // first MAX_IN_FLIGHT sent immediately, without waiting for replies
  expect(scanning()).toEqual(['bookA'])
  await vi.waitFor(() => expect(Object.keys(results)).toHaveLength(6), { timeout: 2000 })
  expect(stats.peak).toBe(MAX_IN_FLIGHT)
  expect([...calls].sort()).toEqual([0, 1, 1, 2, 2, 3, 4, 5])
  expect(results).toEqual({ 0: 'ok', 1: 'ok', 2: 'failed', 3: 'ok', 4: 'ok', 5: 'ok' })
  expect(progress('bookA')).toEqual({ total: 6, done: 5, failed: 1 })
  expect(scanning()).not.toContain('bookA')
})

test('cancel drops photos not sent yet and waits for the ones in flight', async () => {
  const { calls, stats } = fakeFetch(20)
  for (let n = 0; n < 6; n++) enqueue('bookB', n, `photo${n}`)
  await cancel('bookB')
  expect(calls).toEqual([0, 1, 2, 3]) // 4 and 5 never sent
  expect(stats.inFlight).toBe(0) // nothing still uploading when cancel returns
  expect(progress('bookB')).toBeUndefined()
})
