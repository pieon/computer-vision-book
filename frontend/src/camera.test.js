import { expect, test } from 'vitest'
import { crop, pickFrames } from './camera.js'

const video = { videoWidth: 1000, videoHeight: 800 }

test('crop keeps the full width and only the rows inside the band', () => {
  expect(crop(video, { top: 0.2, bottom: 0.8 })).toEqual([0, 160, 1000, 480])
})

test('crop works on an <img> too (a saved shot)', () => {
  expect(crop({ naturalWidth: 1000, naturalHeight: 800 }, { top: 0.25, bottom: 0.5 })).toEqual([0, 200, 1000, 200])
})

test('the default band is the whole frame', () => {
  expect(crop(video)).toEqual([0, 0, 1000, 800])
})

const every150 = (n) => Array.from({ length: n }, (_, i) => i * 150) // frame times, ms

test('pickFrames: 5 frames up to the peak and 5 after it', () => {
  // peak at 1000 ms, between frames 6 (900) and 7 (1050)
  expect(pickFrames(every150(20), 1000, 5, 5)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
})

test('pickFrames: fewer before-frames when the buffer is short', () => {
  expect(pickFrames(every150(8), 200, 5, 5)).toEqual([0, 1, 2, 3, 4, 5, 6])
})

test('pickFrames: null until enough frames after the peak exist', () => {
  expect(pickFrames(every150(10), 1000, 5, 5)).toBeNull() // only frames 7-9 are after it
  expect(pickFrames(every150(5), 1000, 5, 5)).toBeNull() // none after it yet
})
