"""MongoDB handles and the processing lock, shared by the routes."""
import threading

from pymongo import MongoClient

from backend.config import MONGO_URL

BOOK_ID = r"^[A-Za-z0-9_-]{10}$"  # nanoid(10) from App.jsx; no . or /, so a safe folder name

db = MongoClient(MONGO_URL).bookscanner
# one document per book: {_id, texts: raw OCR per page (None while that page is still processing), book: Book2 JSON, scans: [time per page], createdAt, updatedAt}
books = db.books
# one document per reading session: {bookId, start: datetime, minutes: float}; written by routes/listen.py when the book closes
reading = db.reading
# guards a book doc's read-modify-write while pages are added (OCR itself runs outside it, in parallel)
# ponytail: one global lock for all books; per-book locks if several scanners share a server
lock = threading.Lock()
