// Scanned photos upload in the background, several at once, and keep going after the Scanner closes, so the Library
// can show "n of m pages ready". Each photo is sent with its page position (`n`, 0 = cover), so pages land in the
// right place whatever order they finish in (backend/routes/scan.py add_page). A failed upload is retried once, then
// counted as failed; its page stays empty and the pages after it keep their places.
// ponytail: in memory only, so reloading the page drops photos not uploaded yet; persist them if that bites
import { useSyncExternalStore } from 'react'
import { request } from './api.js'

// ponytail: 4 at once per book so ARC isn't flooded; raise it if ARC copes
export const MAX_IN_FLIGHT = 4

const books = new Map() // bookId -> { total, done, failed, waiting: [start fns], running: Set<Promise>, cancelled }
const listeners = new Set()
let version = 0
function changed() {
  version++
  listeners.forEach((f) => f())
}

// Re-render on any change; then read progress() / scanning().
export const useScanQueue = () => useSyncExternalStore(
  (f) => { listeners.add(f); return () => listeners.delete(f) },
  () => version,
)

// { total, done, failed } for a book that was scanned in this tab, else undefined
export function progress(bookId) {
  const b = books.get(bookId)
  return b && { total: b.total, done: b.done, failed: b.failed }
}

// ids of books with photos still uploading or processing
export const scanning = () => [...books].filter(([, b]) => b.done + b.failed < b.total).map(([id]) => id)

// Start waiting photos while there's room.
function pump(b) {
  while (!b.cancelled && b.waiting.length && b.running.size < MAX_IN_FLIGHT) {
    const run = b.waiting.shift()()
    b.running.add(run)
    run.finally(() => { b.running.delete(run); pump(b) })
  }
}

// Send photo `n` of this book now (or as soon as one of the MAX_IN_FLIGHT slots frees up).
// onResult(reply, error, sentAt) runs when it's done; sentAt = when its upload started.
export function enqueue(bookId, n, blob, onResult) {
  let b = books.get(bookId)
  if (!b) books.set(bookId, (b = { total: 0, done: 0, failed: 0, waiting: [], running: new Set(), cancelled: false }))
  b.total++
  changed()
  const send = () => request(`/scan?book=${bookId}&n=${n}`, { method: 'POST', body: blob })
  b.waiting.push(async () => {
    const sentAt = performance.now()
    try {
      const reply = await send().catch(() => send())
      b.done++
      onResult?.(reply, null, sentAt)
    } catch (e) {
      b.failed++
      onResult?.(null, e, sentAt)
    }
    changed()
  })
  pump(b)
}

// Stop a book's uploads: photos not sent yet are dropped, and this waits for the ones in flight, so deleting the book
// afterwards can't be undone by a late upload re-creating it.
export async function cancel(bookId) {
  const b = books.get(bookId)
  if (!b) return
  b.cancelled = true
  b.waiting = []
  while (b.running.size) await Promise.allSettled([...b.running])
  books.delete(bookId)
  changed()
}
