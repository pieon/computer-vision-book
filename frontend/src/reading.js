import nlp from 'compromise'
import { distance } from 'fastest-levenshtein'
import numberToWords from 'number-to-words'

// Convert numeral number to written word
function numbersToWords(text) {
  return text.replace(/\b\d+\.\d+\b|\b(\d+)(st|nd|rd|th)?\b/g, (match, digits, suffix) => {
    if (digits === undefined || Number(digits) > 9999) return match
    return suffix ? numberToWords.toWordsOrdinal(Number(digits)) : numberToWords.toWords(Number(digits))
  })
}

// Use Compromise to expand contractions. I'm -> I am
function expandContractions(text) {
  const doc = nlp(text)
  doc.contractions().expand()
  return doc.text()
}

// Lowercase words, no punctuation: "Twenty-one, Zoe's!" -> ["twenty", "one", "zoes"]
export function words(text) {
  return text.toLowerCase().replace(/-/g, ' ').replace(/[^\p{L}\p{N}\s]/gu, '').split(/\s+/).filter(Boolean)
}

// The book line as word lists: as written, plus an expanded copy when expansion changed anything.
export function variants(line) {
  const text = line.toLowerCase().replace(/[‘’]/g, "'")
  const expanded = expandContractions(numbersToWords(text))
  const lists = [words(text), words(expanded)].filter((w) => w.length)
  return lists.length === 2 && lists[0].join(' ') === lists[1].join(' ') ? [lists[0]] : lists
}

// Same word, allowing one letter added, dropped or changed ("zoe"/"zoey", "said"/"sad") when the words aren't tiny;
function sameWord(a, b) {
  return a === b || (Math.min(a.length, b.length) >= 3 && Math.max(a.length, b.length) >= 4 && distance(a, b) <= 1)
}

// Check if the words in the line match the words in the spoken text.
function matched(line, spoken) {
  const table = [new Array(spoken.length + 1).fill(0)]
  line.forEach((want, i) => {
    const row = [0]
    spoken.forEach((said, j) => row.push(sameWord(want, said) ? table[i][j] + 1 : Math.max(table[i][j + 1], row[j])))
    table.push(row)
  })
  const pairs = []
  for (let i = line.length, j = spoken.length; i > 0 && j > 0;) {
    if (sameWord(line[i - 1], spoken[j - 1]) && table[i][j] === table[i - 1][j - 1] + 1) {
      pairs.push({ at: i - 1, heardAt: j - 1, book: line[i - 1], heard: spoken[j - 1] })
      i--; j--
    } else if (table[i - 1][j] >= table[i][j - 1]) i--
    else j--
  }
  return pairs.reverse()
}

// Were these words said in this order (gaps allowed)?
function saidInOrder(want, spoken) {
  let i = 0
  for (const said of spoken) if (i < want.length && sameWord(want[i], said)) i++
  return i === want.length
}

// Check if the line has been read based on the spoken text.
export function isRead(lineVariants, heard) {
  // just punctuation: nothing to wait for
  if (!lineVariants.length) return { read: true, share: 1, matches: [], missed: [], unmatched: words(heard) }
  const spoken = words(heard)
  let best
  for (const line of lineVariants) {
    const pairs = matched(line, spoken)
    const share = pairs.length / line.length
    const result = {
      read: share >= 0.8 || (share >= 0.5 && saidInOrder(line.slice(-2), spoken)),
      share,
      matches: pairs.map(({ book, heard }) => ({ book, heard })),
      missed: line.filter((_, i) => !pairs.some((p) => p.at === i)),
      unmatched: spoken.filter((_, j) => !pairs.some((p) => p.heardAt === j)),
    }
    if (result.read) return result
    if (!best || share > best.share) best = result
  }
  return best
}
