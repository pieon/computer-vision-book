import { expect, test } from 'vitest'
import { turnFor } from './tilt.js'

test('upright portrait, screen in portrait: no turn', () => {
  expect(turnFor(80, 0, 0)).toBe(0)
})

test('turned clockwise (right edge down), screen locked in portrait: turn 90', () => {
  expect(turnFor(0, 80, 0)).toBe(90)
})

test('turned counter-clockwise, screen locked in portrait: turn 270', () => {
  expect(turnFor(0, -80, 0)).toBe(270)
})

test('turned with the screen turning too: no turn', () => {
  expect(turnFor(0, 80, 270)).toBe(0) // clockwise device = screen angle 270 (browsers count counter-clockwise)
  expect(turnFor(0, -80, 90)).toBe(0)
})

test('upside down, screen in portrait: turn 180', () => {
  expect(turnFor(-80, 0, 0)).toBe(180)
})

test('tilted back while held sideways still reads sideways', () => {
  expect(turnFor(30, 60, 0)).toBe(90)
})

test('flat on the table: unknown', () => {
  expect(turnFor(5, 3, 0)).toBeNull()
})
