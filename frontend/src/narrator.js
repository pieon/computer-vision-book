// One shared <audio> for narration. iOS plays sound only from a tap, so unlock() runs on the tap that opens a book.
export const narrator = new Audio()

// 10 ms of silence (8 kHz, 8-bit WAV)
const SILENCE = 'data:audio/wav;base64,UklGRnQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YVAAAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgA=='

export function unlock() {
  narrator.src = SILENCE
  narrator.play().catch(() => {}) // AbortError from the first line is fine
}
