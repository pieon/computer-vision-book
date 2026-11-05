// Self-check for the reading tracker's matcher. Run: node src/reading.test.js (prints "ok", or throws on a failure)
import assert from 'node:assert/strict'
import { isRead, variants } from './reading.js'

const read = (line, heard) => isRead(variants(line), heard).read

assert.ok(read('Zoe ran to the park.', 'zoe ran to the park'), 'exact')
assert.ok(read('The big brown dog jumped over the fence.', 'the big dog jumped over the fence'), 'one word skipped')
assert.ok(read('Wilbur looked at Charlotte.', 'wilber looked at charlotte'), 'name misheard by one letter')
assert.ok(read('Zoe ran to the park.', 'um zoe zoe ran ran to the uh park'), 'repeats and fillers')
assert.ok(!read('Zoe ran to the park.', 'can I have a snack please'), 'unrelated speech')
assert.ok(!read('The big brown dog jumped over the fence.', 'the big'), 'only started')

assert.ok(read('She had 3 cats.', 'she had three cats'), 'number')
assert.ok(read('It was the 1st day of school.', 'it was the first day of school'), 'ordinal')
assert.ok(read('There were 21 balloons.', 'there were twenty one balloons'), 'two-word number')
assert.ok(read('I can’t go.', 'i can not go'), 'contraction, curly apostrophe')
assert.ok(read("I can't go.", "i can't go"), 'contraction as written')
assert.ok(read("They're here and it's fun.", 'they are here and it is fun'), "'re and pronoun 's")

assert.deepEqual(variants("Zoe's hat"), [['zoes', 'hat']], "possessive 's left alone")
assert.equal(variants('She ran 3.5 miles.').length, 1, 'decimal left as is')
assert.ok(read('...', ''), 'line with no words')

// which words matched (for logging)
const skipped = isRead(variants('The big brown dog jumped over the fence.'), 'the big dog jumped over the fence')
assert.deepEqual(skipped.missed, ['brown'], 'skipped word reported as missed')
assert.equal(skipped.matches.length, 7)
assert.deepEqual(isRead(variants('Wilbur looked at Charlotte.'), 'wilber looked at charlotte').matches[0],
  { book: 'wilbur', heard: 'wilber' }, 'fuzzy pair keeps both spellings')
const notYet = isRead(variants('She had 3 cats.'), 'she had')
assert.ok(!notYet.read && notYet.share === 0.5, 'not read yet still reports progress')
assert.deepEqual(notYet.missed, ['3', 'cats'])
assert.deepEqual(isRead(variants('Zoe ran to the park.'), 'um zoe ran to the big park').unmatched, ['um', 'big'],
  'heard words that matched nothing')
assert.deepEqual(isRead(variants('I’m going to help with our wash.'), 'i am going to help with our wash').unmatched,
  ['i', 'am'], 'first passing variant is the as-written one, so "i am" is unmatched there')

console.log('ok')
