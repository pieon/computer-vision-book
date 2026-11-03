"""Camera app backend: POST a photo to /scan?book=<id> and it's unwarped, OCR'd and added as the next page
of that book in MongoDB (bookscanner.books); page images go to output/books/<id>/.
Replies {"page": "PageOne", "book": <the whole book>, "times": {step: seconds}}; times are also printed per scan.
Usage: python server.py   (camera/vite.config.js proxies /scan and /books here)"""
import os
import shutil
import tempfile
import threading
import time
import traceback
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone

import torch
import uvicorn
from fastapi import FastAPI, HTTPException, Path, Query, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.staticfiles import StaticFiles
from pymongo import MongoClient

from book.book_builder import book_json, build_page, find_names, page_key
from ocr.ocr import ocr  # also loads .env, so MONGO_URL can live there
from unwarp.unwarp_flip import unwarp_img
from unwarp.utils import IMG_SIZE, load_model

IMG_DIR = "output/books"
BOOK_ID = r"^[A-Za-z0-9_-]{10}$"  # nanoid(10) from App.jsx; no . or /, so a safe folder name

device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
model = load_model("weights/best_model.pkl").to(device).eval()
db = MongoClient(os.environ.get("MONGO_URL", "mongodb://localhost:27017")).bookscanner
# one document per book: {_id, texts: raw OCR per page, book: Book2 JSON, scans: [time per page], createdAt, updatedAt}
books = db.books
# one document per reading session: {bookId, start: datetime, minutes: float}; written by the future reader
reading = db.reading
# ponytail: one global lock, so pages are processed one at a time; per-book locks if several scanners share a server
lock = threading.Lock()
app = FastAPI()
os.makedirs(IMG_DIR, exist_ok=True)
# page images by URL, e.g. /images/<id>/page_001.png (the shelf uses page 1 as the cover); StaticFiles blocks ../
# ponytail: full-size PNG as the cover; serve small thumbnails if the shelf gets slow with many books
app.mount("/images", StaticFiles(directory=IMG_DIR), name="images")


@contextmanager
def timed(times, step):
    """Record how long the with-block took, in seconds, as times[step] (also when it raises)."""
    start = time.perf_counter()
    try:
        yield
    finally:
        times[step] = round(time.perf_counter() - start, 3)


def add_page(book_id, photo, times):
    """Unwarp + OCR one photo and append it to the book. Nothing is saved to the DB unless OCR succeeds.
    Fills `times` with seconds per step, so even a failed page shows where the time went."""
    with timed(times, "wait"):  # queued behind another page
        lock.acquire()
    try:
        with timed(times, "db_read"):
            doc = books.find_one({"_id": book_id}) or {}
        texts = doc.get("texts", [])  # all pages' text, so names come from the whole book
        print(f"Existing texts for book {book_id}: {texts}")
        pages = doc["book"][0]["Book"]["Pages"] if doc else {}
        print(f"Existing pages for book {book_id}: {pages}")

        img_dir = os.path.join(IMG_DIR, book_id)
        os.makedirs(img_dir, exist_ok=True)
        img = f"page_{len(texts) + 1:03d}.png"
        with timed(times, "unwarp"), tempfile.NamedTemporaryFile(suffix=".jpg") as f:
            f.write(photo)
            f.flush()
            # the camera app already mirrors the photo, so don't flip it again
            unwarp_img(model, device, f.name, IMG_SIZE, os.path.join(img_dir, img), flip=False)
        with timed(times, "ocr"):
            texts.append(ocr(os.path.join(img_dir, img)))

        with timed(times, "speakers"):  # usually instant; slow when it falls back to the LLM
            # ponytail: earlier pages keep the speakers they got when added; rebuild all pages if late-found names matter
            names = find_names(texts)
            key = page_key(len(texts) - 1)
            pages[key] = build_page(img, texts[-1], names, texts[-2] if len(texts) > 1 else "")
            book = book_json(f"Book {book_id}", pages, names)
        now = datetime.now(timezone.utc)
        with timed(times, "db_write"):
            books.update_one({"_id": book_id},
                             {"$set": {"texts": texts, "book": book, "updatedAt": now}, "$setOnInsert": {"createdAt": now},
                              "$push": {"scans": now}},
                             upsert=True)
        return key, book
    finally:
        lock.release()


def report(book_id, label, times):
    print(f"book {book_id} {label} | " + "  ".join(f"{k} {v:.2f}s" for k, v in times.items())
          + f"  | total {sum(times.values()):.1f}s", flush=True)


@app.post("/scan")
async def scan(request: Request, book: str = Query(pattern=BOOK_ID)):
    times = {}
    with timed(times, "upload"):  # receiving the photo from the app
        photo = await request.body()
    try:
        key, book_data = await run_in_threadpool(add_page, book, photo, times)  # torch + OCR are slow and blocking
    except Exception as e:  # OCR/network failure: tell the app so it shows Retake
        traceback.print_exc()
        report(book, "FAILED", times)
        raise HTTPException(500, str(e))
    report(book, key, times)
    return {"page": key, "book": book_data, "times": times}


@app.get("/books")
def list_books():
    """Shelf: newest first, just what a book tile needs (not the texts or pages); cover = page 1's image file."""
    return list(books.aggregate([
        {"$sort": {"createdAt": -1}},
        {"$project": {"_id": 0, "id": "$_id", "name": {"$first": "$book.Book.Name"},
                      "pages": {"$size": "$texts"}, "createdAt": 1,
                      "cover": {"$first": "$book.Book.Pages.Cover.img"}}},
    ]))


@app.get("/books/{book_id}")
def get_book(book_id: str = Path(pattern=BOOK_ID)):
    """One book's Book2 JSON, as stored."""
    doc = books.find_one({"_id": book_id}, {"book": 1})
    if not doc:
        raise HTTPException(404, "no such book")
    return doc["book"]


@app.delete("/books/{book_id}", status_code=204)
def delete_book(book_id: str = Path(pattern=BOOK_ID)):
    """Remove the book from MongoDB and its page images from disk. The id pattern keeps the path inside IMG_DIR."""
    with lock:  # not in the middle of adding a page to it
        if books.delete_one({"_id": book_id}).deleted_count == 0:
            raise HTTPException(404, "no such book")
        shutil.rmtree(os.path.join(IMG_DIR, book_id), ignore_errors=True)  # may already be gone


@app.get("/stats")
def stats():
    """Home page data: scan times and reading sessions from the last 8 days (raw UTC; the app buckets them into
    its own local Mon-Sun week) and speaker coverage of the most recently updated book."""
    since = datetime.now(timezone.utc) - timedelta(days=8)
    scans = []
    for doc in books.find({"updatedAt": {"$gte": since}}, {"scans": 1, "updatedAt": 1}):
        scans += doc.get("scans") or [doc["updatedAt"]]  # books from before per-page times: their last update
    sessions = list(reading.find({"start": {"$gte": since}}, {"_id": 0, "start": 1, "minutes": 1}))

    latest = None
    doc = books.find_one({}, {"book": 1}, sort=[("updatedAt", -1)])
    if doc:
        book = doc["book"][0]["Book"]
        said = [line["Character"] for page in book["Pages"].values() for line in page["text"]
                if line["Character"] != "Narrator"]
        latest = {"id": doc["_id"], "name": book["Name"], "lines": len(said),
                  "known": sum(c != "Unknown" for c in said)}
    # Mongo hands back naive datetimes that are UTC; mark them so the app's local-time conversion is right
    utc = lambda t: t.replace(tzinfo=timezone.utc).isoformat()  # noqa: E731
    return {"scans": sorted(utc(t) for t in scans if t >= since.replace(tzinfo=None)),
            "reading": [{"start": utc(r["start"]), "minutes": r["minutes"]} for r in sessions],
            "latest": latest}


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8000)
