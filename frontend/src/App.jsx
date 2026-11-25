import { useState } from 'react'
import { nanoid } from 'nanoid'
import Home from './pages/Home.jsx'
import Scanner from './pages/Scanner.jsx'
import Library from './pages/Library.jsx'

export default function App() {
  const [screen, setScreen] = useState('home') // tab: 'home' | 'library'
  const [bookId, setBookId] = useState(null) // set while scanning a new book; Done returns to the tab
  const [resume, setResume] = useState(null) // { id, cast, page }: Home's latest book, opened in the Library's reader

  if (bookId) {
    return <Scanner bookId={bookId} onDone={() => { setBookId(null); setScreen('library') }} /* pages may still be processing; the Library shows them */ onCancel={() => { setBookId(null); setScreen('home') }} />
  }

  // the Library tab opens the plain Library; only Home's latest book opens a book in it
  const nav = { onHome: () => setScreen('home'), onLibrary: () => { setResume(null); setScreen('library') }, onScan: () => setBookId(nanoid(10)) }
  if (screen === 'library') return <Library {...nav} resume={resume} />
  return <Home {...nav} onOpenBook={(r) => { setResume(r); setScreen('library') }} />
}
