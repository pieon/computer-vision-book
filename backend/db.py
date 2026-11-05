"""MongoDB handles and the processing lock, shared by the routes."""
import threading

from pymongo import MongoClient

from backend.config import MONGO_URL

BOOK_ID = r"^[A-Za-z0-9_-]{10}$"  # nanoid(10) from App.jsx; no . or /, so a safe folder name

db = MongoClient(MONGO_URL).bookscanner
# one document per book: {_id, texts: raw OCR per page, book: Book2 JSON, scans: [time per page], createdAt, updatedAt}
books = db.books
# one document per reading session: {bookId, start: datetime, minutes: float}; written by routes/listen.py when the book closes
reading = db.reading
# ponytail: one global lock, so pages are processed one at a time; per-book locks if several scanners share a server
lock = threading.Lock()
