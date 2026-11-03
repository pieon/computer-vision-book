"""POST a photo to /scan?book=<id> and it's unwarped, OCR'd and added as the next page of that book in MongoDB;
page images go to output/books/<id>/. Replies {"page": "PageOne", "book": <the whole book>, "times": {step: seconds}};
times are also printed per scan."""
import os
import tempfile
import time
import traceback
from contextlib import contextmanager
from datetime import datetime, timezone

import torch
from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.concurrency import run_in_threadpool

from backend.config import IMG_DIR, WEIGHTS
from backend.db import BOOK_ID, books, lock
from backend.pipeline.book.book_builder import book_json, build_page, find_names, page_key
from backend.pipeline.ocr import ocr
from backend.pipeline.unwarp.unwarp_flip import unwarp_img
from backend.pipeline.unwarp.utils import IMG_SIZE, load_model

router = APIRouter()
device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
model = load_model(WEIGHTS).to(device).eval()


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


@router.post("/scan")
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
