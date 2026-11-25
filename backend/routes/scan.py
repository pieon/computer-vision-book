"""POST a photo to /scan?book=<id>&n=<page index, 0 = cover> and it's unwarped, OCR'd and saved as that page of the
book in MongoDB; several pages may be sent at once. Page images go to output/books/<id>/. Replies {"page": "PageOne", "book": <the whole book>, "times": {step: seconds}};
times are also printed per scan. The reader's page-turn routes (/turn...) are in turn.py; it shares this file's unwarp
model, timed() and version_paths()."""
import os
import re
import shutil
import tempfile
import threading
import time
import traceback
from contextlib import contextmanager
from datetime import datetime, timezone
from typing import Optional

import cv2
import numpy as np
import torch
from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.concurrency import run_in_threadpool

from backend.config import IMG_DIR, WEIGHTS
from backend.db import BOOK_ID, books, deleted, lock
from backend.pipeline.book.book_builder import book_json, build_page, cover_title, find_names, page_key
from backend.pipeline.book.sounds import prepare_later
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


# ponytail: the torch model is used one photo at a time; drop this lock if parallel inference is shown to be safe
unwarp_lock = threading.Lock()


def image_name(book_id, n):
    """File name for page n's image: page_<n+1>.png by position, so a retry of the same page overwrites it. After
    pages were deleted or reordered (Pages list, books.py) that name may belong to another page; then the first free
    page_<n+1>_<k>.png. Deterministic for the same book state, so a retry still lands on the same file."""
    doc = books.find_one({"_id": book_id}, {"book": 1}) or {}
    pages = doc["book"][0]["Book"]["Pages"] if doc else {}
    own = pages.get(page_key(n), {}).get("img")
    taken = {p["img"] for p in pages.values()} - {own}
    name, k = f"page_{n + 1:03d}.png", 1
    while name in taken:
        name, k = f"page_{n + 1:03d}_{k}.png", k + 1
    return name


def straighten(path, corners):
    """Cut the book out of the photo at `path` by its four corners (8 fractions of the photo: x, y per corner, as the
    Scanner's dots give them) and warp it to a flat, upright rectangle, in place. The corners can come in any order. A
    degenerate quad (an edge under 50 px) leaves the photo as it is."""
    img = cv2.imread(path)
    h, w = img.shape[:2]
    pts = np.float32(corners).reshape(4, 2) * [w, h]
    s, d = pts.sum(1), pts[:, 1] - pts[:, 0]
    tl, br, tr, bl = pts[s.argmin()], pts[s.argmax()], pts[d.argmin()], pts[d.argmax()]
    width = max(np.linalg.norm(tr - tl), np.linalg.norm(br - bl))
    height = max(np.linalg.norm(bl - tl), np.linalg.norm(br - tr))
    edges = [np.linalg.norm(a - b) for a, b in ((tl, tr), (tr, br), (br, bl), (bl, tl))]
    if min(edges) < 50:
        print(f"straighten: corners {corners} are too close together; photo left uncropped", flush=True)
        return
    width, height = int(round(width)), int(round(height))
    m = cv2.getPerspectiveTransform(np.float32([tl, tr, br, bl]),
                                    np.float32([[0, 0], [width - 1, 0], [width - 1, height - 1], [0, height - 1]]))
    cv2.imwrite(path, cv2.warpPerspective(img, m, (width, height)), [cv2.IMWRITE_JPEG_QUALITY, 95])


def add_page(book_id, n, photo, times, corners=None):
    """(corners: the book's four corners in the photo, see straighten; None = use the photo as sent.)
    Unwarp + OCR one photo and save it as page `n` of the book (0 = cover). Several pages can be in here at once:
    unwarp takes turns (unwarp_lock) and OCR, the slow part, runs in parallel; only the DB update takes the book lock.
    Nothing is saved to the DB unless OCR succeeds. Fills `times` with seconds per step, so even a failed page shows
    where the time went. (None, None) if the book was deleted meanwhile."""
    if book_id in deleted:  # cancelled while this page waited: skip the unwarp and OCR
        return None, None
    img_dir = os.path.join(IMG_DIR, book_id)
    os.makedirs(img_dir, exist_ok=True)
    img = image_name(book_id, n)
    with tempfile.TemporaryDirectory() as tmp:
        src = os.path.join(tmp, "photo.jpg")
        with open(src, "wb") as f:
            f.write(photo)
        if corners:
            with timed(times, "corners"):
                straighten(src, corners)
        with timed(times, "unwarp"), unwarp_lock:
            unwarp_img(model, device, src, IMG_SIZE, os.path.join(img_dir, img), flip=False)
    with timed(times, "ocr"):
        text = ocr(os.path.join(img_dir, img))
    key, book = commit_page(book_id, n, img, text, times)
    if key:  # its sound effects and narrator clips are made in the background (the Library shows the progress)
        prepare_later(book_id, book[0]["Book"]["Pages"][key])
    return key, book


def commit_page(book_id, n, img, text, times):
    """Put page `n` into the book doc. Pages can arrive in any order: `texts` has one slot per page (None until that
    page is done), and Pages is rewritten in page order, which the reader and page matching rely on.
    If page n-1 isn't done yet, page n's speakers are worked out without it as context."""
    with timed(times, "wait"):  # another page is updating this book's doc
        lock.acquire()
    try:
        if book_id in deleted:  # deleted while this page was processing: don't let the upsert bring it back
            shutil.rmtree(os.path.join(IMG_DIR, book_id), ignore_errors=True)  # this page's image re-created it
            return None, None
        with timed(times, "db_read"):
            doc = books.find_one({"_id": book_id}) or {}
        texts = doc.get("texts", [])
        texts += [None] * (n + 1 - len(texts))
        texts[n] = text
        pages = doc["book"][0]["Book"]["Pages"] if doc else {}

        with timed(times, "speakers"):  # usually instant; slow when it falls back to the LLM
            # ponytail: earlier pages keep the speakers they got when added; rebuild all pages if late-found names matter]
            names = find_names([t for t in texts if t])  # all pages' text so far, so names come from the whole book
            key = page_key(n)
            pages[key] = build_page(img, text, names, (n and texts[n - 1]) or "")
            pages = {page_key(i): pages[page_key(i)] for i in range(len(texts)) if page_key(i) in pages}
            cover = cover_title(pages[key]) if n == 0 else ""
            name = cover or (doc["book"][0]["Book"]["Name"] if doc else f"Book {book_id}")
            book = book_json(name, pages, names, doc["book"][0]["Book"]["Characters"] if doc else ())
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


def version_paths(book_id, img):
    """Reading versions of page image `img`, newest first: <book>/alt/<img stem>_<YYYYmmdd-HHMMSS-micro>.jpg, one per
    reading photo the user cropped after a decision-model turn (add_version), as taken. Older ones are .png
    (unwarped). /turn tries them, against the photo as taken, when the scans fail."""
    stem = os.path.splitext(os.path.basename(img))[0]
    folder = os.path.join(IMG_DIR, book_id, "alt")
    mine = re.compile(re.escape(stem) + r"_\d{8}-\d{6}-\d{6}\.(png|jpg)")  # not page_003_1's versions for page_003
    names = os.listdir(folder) if os.path.isdir(folder) else []
    return [os.path.join(folder, f) for f in sorted(names, reverse=True) if mine.fullmatch(f)]


def add_version(book_id, n, photo, times):
    """Save a reading photo (already cropped to the book by the user) as another version of page n's image, as taken:
    not unwarped, so it keeps the tilt and distance the reading camera sees. No OCR, no DB change. Returns its path;
    None if the book has no page n."""
    doc = books.find_one({"_id": book_id}, {"book": 1}) or {}
    pages = list(doc["book"][0]["Book"]["Pages"].values()) if doc else []  # reader order, same as turn.py
    if n >= len(pages):
        return None
    stem = os.path.splitext(os.path.basename(pages[n]["img"]))[0]
    out = os.path.join(IMG_DIR, book_id, "alt", f"{stem}_{datetime.now().strftime('%Y%m%d-%H%M%S-%f')}.jpg")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with timed(times, "save"), open(out, "wb") as f:
        f.write(photo)
    return out


@router.post("/scan/version")
async def scan_version(request: Request, book: str = Query(pattern=BOOK_ID), n: int = Query(ge=0, le=999)):
    """The reader's photo of page n (cropped to the book by the user), saved as another fingerprint version of it.
    Replies {"saved": path, "times": {step: seconds}}."""
    times = {}
    with timed(times, "upload"):
        photo = await request.body()
    try:
        saved = await run_in_threadpool(add_version, book, n, photo, times)
    except Exception as e:
        traceback.print_exc()
        report(book, f"version of page {n} FAILED", times)
        raise HTTPException(500, str(e))
    if not saved:
        raise HTTPException(404, "no such page")
    report(book, f"version of page {n} -> {os.path.basename(saved)}", times)
    return {"saved": os.path.relpath(saved, IMG_DIR), "times": times}


@router.post("/scan")
async def scan(request: Request, book: str = Query(pattern=BOOK_ID), n: int = Query(ge=0, le=999),
               corners: Optional[str] = Query(None, pattern=r"^[0-9.]+(,[0-9.]+){7}$")):
    """corners: the book's corners in the photo, "x,y" x4 as fractions (the Scanner's dots): it's straightened to them
    before the unwarp."""
    times = {}
    with timed(times, "upload"):  # receiving the photo from the app
        photo = await request.body()
    try:
        key, book_data = await run_in_threadpool(add_page, book, n, photo, times,
                                                     [float(v) for v in corners.split(",")] if corners else None)  # torch + OCR are slow and blocking
    except Exception as e:  # OCR/network failure: tell the app (it retries once)
        traceback.print_exc()
        report(book, f"page {n} FAILED", times)
        raise HTTPException(500, str(e))
    report(book, key, times)
    return {"page": key, "book": book_data, "times": times}
