import { useState } from 'react'
import { nanoid } from 'nanoid'
import Home from './pages/Home.jsx'
import Scanner from './pages/Scanner.jsx'
import Library from './pages/Library.jsx'

export default function App() {
  const [screen, setScreen] = useState('home') // tab: 'home' | 'library'
  const [bookId, setBookId] = useState(null) // new book being scanned
  const [resume, setResume] = useState(null) // { id, cast, page } from Home

  if (bookId) {
    return <Scanner bookId={bookId} onDone={() => { setBookId(null); setScreen('library') }} onCancel={() => { setBookId(null); setScreen('home') }} />
  }

  // the Library tab opens the plain Library
  const nav = { onHome: () => setScreen('home'), onLibrary: () => { setResume(null); setScreen('library') }, onScan: () => setBookId(nanoid(10)) }
  if (screen === 'library') return <Library {...nav} resume={resume} />
  return <Home {...nav} onOpenBook={(r) => { setResume(r); setScreen('library') }} />
}
