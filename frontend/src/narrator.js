// One shared <audio> for narration. Safari (and every iOS browser) only lets a page start sound from a tap, but an
// element that was played once from a tap may play again later without one, e.g. after a camera-detected page turn.
// So unlock() runs on the tap that opens a book, and every narration line then plays through `narrator`.
export const narrator = new Audio()

// 10 ms of silence (8 kHz, 8-bit WAV)
const SILENCE = 'data:audio/wav;base64,UklGRnQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YVAAAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgA=='

export function unlock() {
  narrator.src = SILENCE
  narrator.play().catch(() => {}) // replaced by the first narration line right away (AbortError) is fine
}
