// The voice agents' orbs: picked per character in Cast (pages/Cast.jsx), lined up in the reader (pages/Book.jsx).
// Styles: .cast-orb* in index.css.
// CA's mates (CA/src/Book/Roles.js): a Gemini prebuilt voice each, and a color and body for its orb: shape is a
// border-radius, w its width relative to its height
export const VOICES = [
  { name: 'Orange Opal', voice: 'Aoede', color: '#ff9f43', shape: '28%' }, // rounded square
  { name: 'Green Grant', voice: 'Umbriel', color: '#2ecc71', shape: '64% 36% 58% 42% / 48% 62% 38% 52%' }, // blob
  { name: 'Yellow Yancey', voice: 'Puck', color: '#f1c40f', shape: '999px', w: 1.35 }, // wide pill
  { name: 'Violet Victor', voice: 'Enceladus', color: '#9b59b6', shape: '50% 50% 50% 6%' }, // drop
  { name: 'Blue Beatrice', voice: 'Zephyr', color: '#3498db', shape: '50% 50% 10% 10% / 64% 64% 10% 10%' }, // dome
  { name: 'Ruby Randy', voice: 'Iapetus', color: '#e74c3c', shape: '6% 64%' }, // leaf
  { name: 'Coral Carly', voice: 'Kore', color: '#ff7f6e', shape: '50%', w: 0.78 }, // tall egg
]
export const READER = { name: 'Reader (me)', voice: 'reader', color: '#f5f5f5', shape: '50%' } // never leaves the ring; boxes get a copy
// orb body: color, size, shape, and a different blink moment per voice so they don't all blink together
export const orbStyle = (orb, size) => `--c:${orb.color};--s:${size}px;--r:${orb.shape};--w:${orb.w ?? 1};--d:${(VOICES.indexOf(orb) + 1) * 0.7}s`
export const orbOf = (key) => (key === READER.voice ? READER : VOICES.find((v) => v.voice === key))

// One orb, optionally with its name under it.
export function Orb({ orb, size = 56, label = true }) {
  return (
    <span className="cast-orb-wrap">
      <span className={`cast-orb${orb === READER ? ' cast-orb-reader' : ''}`} style={Object.fromEntries(orbStyle(orb, size).split(';').map((d) => d.split(':')))} />
      {label && <span className="cast-orb-name">{orb.name}</span>}
    </span>
  )
}
