// Scanned photos upload in the background, several at once, and keep going after the Scanner closes, so the Library
// can show "n of m pages ready". Each photo is sent with its page position (`n`, 0 = cover), so pages land in the
// right place whatever order they finish in (backend/routes/scan.py add_page). A failed upload is retried once, then
// counted as failed; its page stays empty and the pages after it keep their places.
// ponytail: in memory only, so reloading the page drops photos not uploaded yet; persist them if that bites
import { useSyncExternalStore } from 'react'
import { request } from './api.js'

// At most this many uploads at once across all books: the browser opens only 6 connections to the server (HTTP/1.1
// through the Vite proxy), so 2 stay free for /books, /images and /stats. Also keeps ARC from being flooded.
export const MAX_IN_FLIGHT = 4

const books = new Map() // bookId -> { total, done, failed, cancelled, uploads: Set<AbortController> }
let waiting = [] // { bookId, start }, sent in order; covers go first so a new book's Library tile fills in quickly
let running = 0
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
function pump() {
  while (waiting.length && running < MAX_IN_FLIGHT) {
    running++
    waiting.shift().start().finally(() => { running--; pump() })
  }
}

// Send photo `n` of this book now (or as soon as one of the MAX_IN_FLIGHT slots frees up).
// corners: the book's corners in the photo, [x, y] x4 as fractions (Scanner's dots), or null.
// onResult(reply, error, sentAt) runs when it's done (not if the book was cancelled); sentAt = when its upload started.
export function enqueue(bookId, n, blob, onResult, corners = null) {
  let b = books.get(bookId)
  if (!b) books.set(bookId, (b = { total: 0, done: 0, failed: 0, cancelled: false, uploads: new Set() }))
  b.total++
  changed()
  const start = async () => {
    const sentAt = performance.now()
    const upload = new AbortController()
    b.uploads.add(upload)
    const send = () => request(`/scan?${new URLSearchParams({ book: bookId, n, ...(corners && { corners: corners.map((v) => v.toFixed(4)).join(',') }) })}`, { method: 'POST', body: blob, signal: upload.signal })
    try {
      const reply = await send().catch((e) => { if (b.cancelled) throw e; return send() })
      if (b.cancelled) return
      b.done++
      onResult?.(reply, null, sentAt)
    } catch (e) {
      if (b.cancelled) return
      b.failed++
      onResult?.(null, e, sentAt)
    } finally {
      b.uploads.delete(upload)
    }
    changed()
  }
  const job = { bookId, start }
  if (n === 0) waiting.unshift(job)
  else waiting.push(job)
  pump()
}

// Stop a book's uploads right away: photos not sent yet are dropped and the ones in flight are aborted. The server may
// still finish a page it already started; DELETE /books/<id> makes it drop that page (backend/routes/scan.py).
export function cancel(bookId) {
  const b = books.get(bookId)
  if (!b) return
  b.cancelled = true
  waiting = waiting.filter((job) => job.bookId !== bookId)
  b.uploads.forEach((u) => u.abort())
  books.delete(bookId)
  changed()
}
