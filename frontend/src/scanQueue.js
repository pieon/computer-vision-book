// Background photo uploads, several at once; polls /books/<id>/progress until each book is ready.
// ponytail: in memory only; a reload drops unsent photos
import { useSyncExternalStore } from 'react'
import { getJson, request } from './api.js'

// Uploads at once across books (the browser allows 6 connections; 2 stay free)
export const MAX_IN_FLIGHT = 4

// Step weights, about their median seconds (2026-11-25)
export const WEIGHTS = { text: 9, sounds: 8, voice: 7 }
const STALL_MS = 120_000 // no progress this long: show the book anyway

// Fraction done, 0..1; failed uploads count as done
export function fraction(ns, failed, status) {
  const all = WEIGHTS.text + WEIGHTS.sounds + WEIGHTS.voice
  let sum = 0
  for (const n of ns) {
    const s = status?.[n]
    if (failed.has(n)) sum += all
    else if (s?.text) sum += WEIGHTS.text + (s.sounds ? WEIGHTS.sounds : 0) + WEIGHTS.voice * (s.voice[1] ? s.voice[0] / s.voice[1] : 1)
  }
  return ns.length ? sum / (ns.length * all) : 0
}

// bookId -> upload and progress state
const books = new Map()
let waiting = [] // { bookId, start }; covers first
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

// Progress of a book scanned in this tab
export function progress(bookId) {
  const b = books.get(bookId)
  return b && { total: b.total, done: b.done, failed: b.failed, fraction: b.fraction, ready: b.ready, stalled: b.stalled }
}

// Changes when a page lands or a book is ready: a reload key
export const landed = () => [...books].map(([id, b]) => `${id}:${b.done}:${b.ready}`).join()

// ids of books still uploading or being prepared (OCR, sounds, narrator clips)
export const scanning = () => [...books].filter(([, b]) => !b.ready).map(([id]) => id)

// Poll unready books once a second
let polling = null
function poll() {
  const open = [...books].filter(([, b]) => !b.ready)
  if (!open.length) {
    clearInterval(polling)
    polling = null
    return
  }
  polling ??= setInterval(poll, 1000)
  for (const [id, b] of open) {
    if (b.asking) continue
    b.asking = true
    getJson(`/books/${id}/progress?n=${b.ns.join(',')}`)
      .then((status) => { b.status = status })
      .catch(() => {}) // asked again next second
      .finally(() => { b.asking = false; if (books.get(id) === b) update(b) })
  }
}

function update(b) {
  const f = fraction(b.ns, b.failedNs, b.status)
  const now = performance.now()
  if (f !== b.fraction) {
    b.fraction = f
    b.changedAt = now
  }
  if (b.done + b.failed === b.total && (f >= 1 || now - b.changedAt > STALL_MS)) {
    b.ready = true
    b.stalled = f < 1
  }
  changed()
}

// Start waiting photos while there's room.
function pump() {
  while (waiting.length && running < MAX_IN_FLIGHT) {
    running++
    waiting.shift().start().finally(() => { running--; pump() })
  }
}

// Send photo `n` when a slot frees. corners: [x, y] x4 fractions, or null.
export function enqueue(bookId, n, blob, onResult, corners = null) {
  let b = books.get(bookId)
  if (!b) books.set(bookId, (b = { total: 0, done: 0, failed: 0, cancelled: false, uploads: new Set(), ns: [], failedNs: new Set(), fraction: 0, ready: false }))
  b.total++
  b.ns.push(n)
  b.ready = false // more pages added
  b.changedAt = performance.now()
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
      b.failedNs.add(n)
      onResult?.(null, e, sentAt)
    } finally {
      b.uploads.delete(upload)
    }
    changed()
    poll() // show the text now
  }
  const job = { bookId, start }
  if (n === 0) waiting.unshift(job)
  else waiting.push(job)
  pump()
}

// Stop a book's uploads now; DELETE /books/<id> drops late pages
export function cancel(bookId) {
  const b = books.get(bookId)
  if (!b) return
  b.cancelled = true
  waiting = waiting.filter((job) => job.bookId !== bookId)
  b.uploads.forEach((u) => u.abort())
  books.delete(bookId)
  changed()
}
