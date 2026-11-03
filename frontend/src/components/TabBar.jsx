import { HomeIcon, LibraryIcon, ScanIcon } from './icons.jsx'

// Floating bottom navigation shared by Home and Library; Scan opens the camera for a new book.
export default function TabBar({ active, onHome, onLibrary, onScan }) {
  const tab = (name, label, icon, onClick) => (
    <button type="button" className={active === name ? 'tabbar-active' : undefined}
      aria-current={active === name ? 'page' : undefined} onClick={active === name ? undefined : onClick}>
      {icon}{label}
    </button>
  )
  return (
    <nav className="tabbar" aria-label="Main">
      {tab('home', 'Home', HomeIcon, onHome)}
      {tab('library', 'Library', LibraryIcon, onLibrary)}
      {tab('scan', 'Scan', ScanIcon, onScan)}
    </nav>
  )
}
