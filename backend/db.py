"""MongoDB handles and the processing lock, shared by the routes."""
import threading

from pymongo import MongoClient

from backend.config import MONGO_URL

BOOK_ID = r"^[A-Za-z0-9_-]{10}$"  # nanoid(10) from App.jsx; no . or /, so a safe folder name

db = MongoClient(MONGO_URL).bookscanner
# one doc per book: {_id, texts, book (Book2 JSON), scans, createdAt, updatedAt}
books = db.books
# one doc per reading session: {bookId, start, minutes}
reading = db.reading
# guards a book doc's read-modify-write
# ponytail: one global lock; per-book locks if several scanners share a server
lock = threading.Lock()
# deleted book ids: their late pages are dropped
# ponytail: in memory; a restart forgets it
deleted = set()
