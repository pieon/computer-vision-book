import { useState } from 'react'
import { nanoid } from 'nanoid'
import Home from './pages/Home.jsx'
import Scanner from './pages/Scanner.jsx'
import Library from './pages/Library.jsx'

export default function App() {
  const [screen, setScreen] = useState('home') // tab: 'home' | 'library'
  const [bookId, setBookId] = useState(null) // set while scanning a new book; Done returns to the tab

  if (bookId) {
    return <Scanner bookId={bookId} onDone={() => { setBookId(null); setScreen('library') }} /* pages may still be processing; the Library shows them */ onCancel={() => { setBookId(null); setScreen('home') }} />
  }

  const nav = { onHome: () => setScreen('home'), onLibrary: () => setScreen('library'), onScan: () => setBookId(nanoid(10)) }
  return screen === 'library' ? <Library {...nav} /> : <Home {...nav} />
}
