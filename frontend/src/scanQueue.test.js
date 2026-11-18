import { expect, test, vi } from 'vitest'
import { cancel, enqueue, MAX_IN_FLIGHT, progress, scanning } from './scanQueue.js'

// fetch that answers after `ms`; `fail(n, attempt)` says whether that call fails. Records calls and peak concurrency.
function fakeFetch(ms, fail = () => false) {
  const calls = []
  const stats = { inFlight: 0, peak: 0 }
  globalThis.fetch = vi.fn(async (url, { signal } = {}) => {
    const q = new URL(url, 'http://x').searchParams
    const n = Number(q.get('n'))
    const attempt = calls.filter((c) => c === n).length + 1
    calls.push(n)
    stats.urls = [...(stats.urls ?? []), `${q.get('book')}/${n}`]
    stats.peak = Math.max(stats.peak, ++stats.inFlight)
    try {
      await new Promise((resolve, reject) => {
        setTimeout(resolve, ms)
        signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      })
    } finally {
      stats.inFlight--
    }
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

test('cancel returns at once: photos not sent yet are dropped, the ones in flight aborted and not retried', async () => {
  const { calls, stats } = fakeFetch(1000)
  const results = []
  for (let n = 0; n < 6; n++) enqueue('bookB', n, `photo${n}`, (reply) => results.push(reply))
  cancel('bookB')
  expect(progress('bookB')).toBeUndefined()
  await vi.waitFor(() => expect(stats.inFlight).toBe(0), { timeout: 200 }) // aborted, not waited for
  await new Promise((r) => setTimeout(r, 20))
  expect(calls).toEqual([0, 1, 2, 3]) // 4 and 5 never sent, nothing retried
  expect(results).toEqual([]) // no callbacks for a cancelled book
})

test('one limit across books, and a new book\'s cover goes first', async () => {
  const { stats } = fakeFetch(20)
  for (let n = 1; n < 8; n++) enqueue('bookC', n, `photo${n}`)
  enqueue('bookD', 0, 'cover')
  enqueue('bookD', 1, 'photo1')
  expect(stats.urls.slice(-4)).toEqual(['bookC/1', 'bookC/2', 'bookC/3', 'bookC/4'])
  await vi.waitFor(() => expect(scanning()).toEqual([]), { timeout: 2000 })
  const sent = stats.urls.slice(-9)
  expect(sent[4]).toBe('bookD/0') // the first free slot goes to the cover, ahead of bookC's waiting pages
  expect(sent.at(-1)).toBe('bookD/1') // other pages keep their place in line
  expect(stats.peak).toBe(MAX_IN_FLIGHT) // never more than the limit across both books
})
