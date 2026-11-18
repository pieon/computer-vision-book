// 24px line icons in the current text color.
const icon = (d) => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{d}</svg>
)

export const SortIcon = icon(<><path d="M7 20V4M3 8l4-4 4 4" /><path d="M17 4v16M13 16l4 4 4-4" /></>)
export const SearchIcon = icon(<><circle cx="11" cy="11" r="7" /><path d="M20 20l-4-4" /></>)
export const HomeIcon = icon(<path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z" />)
export const LibraryIcon = icon(<><path d="M5 4h3v16H5zM10 4h3v16h-3z" /><path d="M15.5 4.5l2.9-.8 3.6 15.4-2.9.8z" /></>)
export const ScanIcon = icon(<><path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2" /><circle cx="12" cy="12" r="3" /></>)
export const TrashIcon = icon(<><path d="M4 7h16M10 11v6M14 11v6" /><path d="M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-12M9 7V4h6v3" /></>)
export const PrevIcon = icon(<><path d="M19 20L9 12l10-8z" /><path d="M5 19V5" /></>)
export const PlayIcon = icon(<path d="M6 4l14 8-14 8z" />)
export const PauseIcon = icon(<path d="M7 4v16M17 4v16" />)
export const NextIcon = icon(<><path d="M5 4l10 8-10 8z" /><path d="M19 5v14" /></>)
// arched arrows (a page flipping over): left end for the previous page, right end for the next
export const PrevPageIcon = icon(<><path d="M20 16a8 8 0 0 0-16 0" /><path d="M1 13l3 3 3-3" /></>)
export const NextPageIcon = icon(<><path d="M4 16a8 8 0 0 1 16 0" /><path d="M17 13l3 3 3-3" /></>)
export const MicIcon = icon(<><rect x="9" y="2" width="6" height="12" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v4M8 22h8" /></>)
export const FlagIcon = icon(<path d="M5 21V4h11l-2 4 2 4H5" />) // outlined; CSS fills it when flagged

// Grey head-and-shoulders placeholder for someone with no picture (the Narrator on the Cast screen); filled, so not icon()
export const PersonSilhouette = ({ className }) => (
  <svg className={className} viewBox="0 0 56 56" aria-hidden="true">
    <circle cx="28" cy="21" r="10" />
    <path d="M8 56c0-12 9-20 20-20s20 8 20 20z" />
  </svg>
)
