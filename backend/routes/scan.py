"""POST a photo to /scan?book=<id>&n=<page index, 0 = cover> and it's unwarped, OCR'd and saved as that page of the
book in MongoDB; several pages may be sent at once. Page images go to output/books/<id>/. Replies {"page": "PageOne", "book": <the whole book>, "times": {step: seconds}};
times are also printed per scan."""
import base64
import os
import re
import shutil
import tempfile
import threading
import time
import traceback
from contextlib import contextmanager
from datetime import datetime, timezone

import cv2
import numpy as np
import torch
from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.concurrency import run_in_threadpool

from backend import reading_log
from backend.config import IMG_DIR, ROOT, WEIGHTS
from backend.db import BOOK_ID, books, deleted, lock
from backend.pipeline.book.book_builder import book_json, build_page, find_names, page_key
from backend.clients.arc import decide
from backend.pipeline.ocr import ocr
from backend.pipeline.unwarp.unwarp_flip import unwarp_img
from backend.pipeline.unwarp.utils import IMG_SIZE, load_model

router = APIRouter()
SHEET_DIR = os.path.join(ROOT, "output", "turn_sheets")  # every /turn/decide sheet, one folder per reading
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


def add_page(book_id, n, photo, times):
    """Unwarp + OCR one photo and save it as page `n` of the book (0 = cover). Several pages can be in here at once:
    unwarp takes turns (unwarp_lock) and OCR, the slow part, runs in parallel; only the DB update takes the book lock.
    Nothing is saved to the DB unless OCR succeeds. Fills `times` with seconds per step, so even a failed page shows
    where the time went. (None, None) if the book was deleted meanwhile."""
    if book_id in deleted:  # cancelled while this page waited: skip the unwarp and OCR
        return None, None
    img_dir = os.path.join(IMG_DIR, book_id)
    os.makedirs(img_dir, exist_ok=True)
    img = image_name(book_id, n)
    with timed(times, "unwarp"), unwarp_lock, tempfile.NamedTemporaryFile(suffix=".jpg") as f:
        f.write(photo)
        f.flush()
        unwarp_img(model, device, f.name, IMG_SIZE, os.path.join(img_dir, img), flip=False)
    with timed(times, "ocr"):
        text = ocr(os.path.join(img_dir, img))
    return commit_page(book_id, n, img, text, times)


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
            cover = (texts[0] or "").strip().split("\n")[0][:80]
            name = cover if n == 0 and cover else (doc["book"][0]["Book"]["Name"] if doc else f"Book {book_id}")
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


def page_after_turn(book_id, page, photo, times):
    """Unwarp the photo (nothing saved) and compare it with the scanned images of this page and the next.
    Returns (matching page, or `page` if nothing matches well; {page: inliers}). Fills `times` like add_page."""
    with timed(times, "db_read"):
        doc = books.find_one({"_id": book_id}, {"book": 1}) or {}
        pages = doc["book"][0]["Book"]["Pages"].values() if doc else []
        paths = [os.path.join(IMG_DIR, book_id, p["img"]) for p in pages]  # reader order, same as Book.jsx
    with tempfile.TemporaryDirectory() as tmp:
        src, out = os.path.join(tmp, "photo.jpg"), os.path.join(tmp, "page.png")
        with open(src, "wb") as f:
            f.write(photo)
        with timed(times, "unwarp"):
            unwarp_img(model, device, src, IMG_SIZE, out, flip=False)  # same as add_page: the app already mirrored it
        with timed(times, "match"):
            return image_page_check(out, paths, page)


def sheet_decision(sheet, page, reading, times):
    """Ask ARC's decision model if the 10-frame sheet (Book.jsx/camera.js frameSheet: 5x2 grid, numbered in time
    order) shows a page being turned. Saves the sheet under output/turn_sheets/<reading>/ with the answer in its
    name. {"moving", "p", "error", "saved"}; never raises, so a failed ARC call just means "not turned" this round."""
    q = {"turn": {"type": "choice",
                  "instructions": "One image with 10 numbered camera frames of a children's book, in time order: "
                                  "1-5 on the top row left to right, then 6-10 on the bottom row. "
                                  "Is a page being turned to the next page in these frames?",
                  "criteria": {"moving": "a page is being turned or has just been turned",
                               "still": "the same page stays open; no page turn"}}}
    result = {"moving": None, "p": None, "error": None}
    try:
        with timed(times, "decide"):
            url = f"data:image/jpeg;base64,{base64.b64encode(sheet).decode()}"
            a = decide("Page-turn check for a children's picture book.", q, [url])["turn"]
        result.update(moving=a["choice"] == "moving", p=round(a["probabilities"][a["choice"]], 3))
    except Exception as e:
        result["error"] = repr(e)[:200]
    label = "error" if result["error"] else f"{'moving' if result['moving'] else 'still'}_p{result['p']}"
    result["saved"] = save_sheet(sheet, page, reading, label)
    return result


def save_sheet(sheet, page, reading, label):
    """Write a 10-frame sheet to output/turn_sheets/<reading>/<time>_p<page>_<label>.jpg; returns that path,
    relative to the repo."""
    # ponytail: sheets are kept forever (~100 KB each); delete output/turn_sheets/ when done looking
    folder = os.path.join(SHEET_DIR, re.sub(r"[^A-Za-z0-9_-]", "_", reading) or "no-reading")
    os.makedirs(folder, exist_ok=True)
    name = f"{datetime.now().strftime('%H-%M-%S-%f')[:-3]}_p{page + 1}_{label}.jpg"
    with open(os.path.join(folder, name), "wb") as f:
        f.write(sheet)
    return os.path.relpath(os.path.join(folder, name), ROOT)


def _features(path, width=800):
    """ORB keypoints + descriptors of an image, grayscale at `width` px so photo and scan share a scale."""
    img = cv2.imread(path, cv2.IMREAD_GRAYSCALE)
    if img is None:
        return [], None
    img = cv2.resize(img, (width, round(img.shape[0] * width / img.shape[1])))
    return cv2.ORB_create(1500).detectAndCompute(img, None)


def image_page_check(photo_path, page_paths, page):
    """Does the unwarped photo show this page or the next one? Score = RANSAC inliers of ORB matches against each
    page's scan (features that line up as one flat page, so a hand or a half-turned page scores low).
    `page` if neither matches well enough (no going back)."""
    kp, des = _features(photo_path)
    matcher = cv2.BFMatcher(cv2.NORM_HAMMING)
    scores = {}
    for i in (page, page + 1):
        if i >= len(page_paths):
            continue
        kp2, des2 = _features(page_paths[i])
        scores[i] = 0
        if des is None or des2 is None or len(des2) < 2:
            continue
        good = [m[0] for m in matcher.knnMatch(des, des2, k=2) if len(m) == 2 and m[0].distance < 0.75 * m[1].distance]
        if len(good) < 4:  # findHomography needs 4 points
            continue
        _, mask = cv2.findHomography(np.float32([kp[m.queryIdx].pt for m in good]),
                                     np.float32([kp2[m.trainIdx].pt for m in good]), cv2.RANSAC, 5.0)
        scores[i] = int(mask.sum()) if mask is not None else 0
    best = max(scores, key=scores.get, default=page)
    # ponytail: fixed 25-inlier cutoff, tune from the scores in output/reading_logs/
    return (best if scores.get(best, 0) >= 25 else page), scores


@router.post("/turn")
async def turn(request: Request, book: str = Query(pattern=BOOK_ID), page: int = Query(ge=0), reading: str = ""):
    """The reader saw the real book's page turn: POST a photo, get back which page it shows now.
    Replies {"page": <index in Pages order>, "scores": {index: RANSAC inliers}, "times": {step: seconds}};
    times are also printed and written to the reading log."""
    times = {}
    with timed(times, "upload"):
        photo = await request.body()
    try:
        best, scores = await run_in_threadpool(page_after_turn, book, page, photo, times)
    except Exception as e:
        traceback.print_exc()
        report(book, f"turn from {page} FAILED", times)
        reading_log.log(reading, "turn failed", f"{e!r} | {times}")
        raise HTTPException(500, str(e))
    report(book, f"turn {page} -> {best}", times)
    reading_log.log(reading, "turn", f"on page {page} -> {best}, scores {scores} | {times}")
    return {"page": best, "scores": scores, "times": times}


@router.post("/turn/decide")
async def turn_decide(request: Request, book: str = Query(pattern=BOOK_ID), page: int = Query(ge=0), reading: str = ""):
    """The reader's page-turn check (Book.jsx turns on "moving"): POST a 10-frame sheet JPEG, get the decision model's
    {"moving": bool, "p": probability, "error", "saved": sheet path, "times": {step: seconds}}."""
    times = {}
    with timed(times, "upload"):
        sheet = await request.body()
    result = await run_in_threadpool(sheet_decision, sheet, page, reading, times)
    report(book, f"turn decide on {page} -> {result['error'] or result['moving']}", times)
    reading_log.log(reading, "turn decide", f"on page {page} -> {result} | {times}")
    return {**result, "times": times}


@router.post("/turn/sheet")
async def turn_sheet(request: Request, book: str = Query(pattern=BOOK_ID), page: int = Query(ge=0), reading: str = "",
                     motion: float = Query(0, ge=0, le=100)):
    """Save only (no model call): a 10-frame sheet the reader took when the camera moved while it waited for a page
    turn (Book.jsx SAVE_SHEETS). Replies {"saved": path}."""
    sheet = await request.body()
    saved = await run_in_threadpool(save_sheet, sheet, page, reading, f"motion{motion:.0f}")
    reading_log.log(reading, "turn sheet", f"on page {page}, motion {motion:.1f} -> {saved}")
    return {"saved": saved}


@router.post("/scan")
async def scan(request: Request, book: str = Query(pattern=BOOK_ID), n: int = Query(ge=0, le=999)):
    times = {}
    with timed(times, "upload"):  # receiving the photo from the app
        photo = await request.body()
    try:
        key, book_data = await run_in_threadpool(add_page, book, n, photo, times)  # torch + OCR are slow and blocking
    except Exception as e:  # OCR/network failure: tell the app (it retries once)
        traceback.print_exc()
        report(book, f"page {n} FAILED", times)
        raise HTTPException(500, str(e))
    report(book, key, times)
    return {"page": key, "book": book_data, "times": times}
