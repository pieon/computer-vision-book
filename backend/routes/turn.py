"""Page-turn routes: /turn (ORB page match), /turn/decide (decision model on a sheet), /turn/sheet (save only)."""
import base64
import functools
import os
import re
import tempfile
import traceback
from datetime import datetime

import cv2
import numpy as np
from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.concurrency import run_in_threadpool

from backend import reading_log
from backend.clients.arc import decide
from backend.config import IMG_DIR, ROOT
from backend.db import BOOK_ID, books
from backend.pipeline.unwarp.unwarp_flip import unwarp_img
from backend.pipeline.unwarp.utils import IMG_SIZE
from backend.routes.scan import device, model, report, timed, version_paths

router = APIRouter()
SHEET_DIR = os.path.join(ROOT, "output", "turn_sheets") # one folder per reading
# a "page_turn" turns only this sure
# ponytail: tune from the p in output/turn_sheets/ file names
TURN_P = 0.65


def page_after_turn(book_id, page, photo, times):
    """Which page the photo shows: the scans first, then reading versions if unsure. Returns (page, counts, version)."""
    with timed(times, "db_read"):
        doc = books.find_one({"_id": book_id}, {"book": 1}) or {}
        pages = doc["book"][0]["Book"]["Pages"].values() if doc else []
        paths = [os.path.join(IMG_DIR, book_id, p["img"]) for p in pages]  # reader order, same as Book.jsx
        versions = [version_paths(book_id, p["img"]) for p in pages]
    with tempfile.TemporaryDirectory() as tmp:
        src, out = os.path.join(tmp, "photo.jpg"), os.path.join(tmp, "page.png")
        with open(src, "wb") as f:
            f.write(photo)
        with timed(times, "unwarp"):
            unwarp_img(model, device, src, IMG_SIZE, out, flip=False)  # same as add_page: the app already mirrored it
        with timed(times, "match"):
            best, scores = _page_check(out, paths, page)
        if any(s["inliers"] >= 25 for s in scores.values()):
            return best, scores, None
        with timed(times, "match_versions"):
            found = version_check(src, versions, page)
    return found or (best, scores, None)


def sheet_decision(sheet, page, reading, times):
    """Ask the decision model whether the sheet shows a page turn; saves the sheet. Never raises.
    Returns {choice, page_turn (sure turns only), p, error, saved}."""
    # page_turn needs both the sweep and a changed spread, or hands and blur trigger it
    q = {"turn": {
    "type": "choice",
    "instructions": (
        "The image is a grid of 10 camera frames, about 1.5 seconds of video of an open children's picture book, "
        "in time order: left to right, top to bottom, numbered 1 to 10. "
        "Compare the open pages in the first frames (1-2) with the last frames (9-10), and look at the frames in "
        "between for a page sweeping from one side of the book to the other. Is a page turned over?"
    ),
    "criteria": {
        "page_turn": "A page is turned over: it sweeps across from one side of the book to the other, and the open "
                     "pages at the end show different pictures or text than at the start.",
        "no_turn": "No page is turned over. This includes the book lying still; a hand touching, holding or lifting a "
                   "page corner without turning it over; a page lifted and laid back down; the book being moved, "
                   "tilted or rotated; motion blur or a hand passing in front.",
        "unclear": "The book's pages are not visible enough to tell: covered, out of frame, or too blurry in most frames.",
    }}}
    result = {"choice": None, "page_turn": False, "p": None, "error": None}
    try:
        with timed(times, "decide"):
            url = f"data:image/jpeg;base64,{base64.b64encode(sheet).decode()}"
            a = decide("Page-turn check for a children's picture book.", q, [url])["turn"]
        if a["choice"] not in q["turn"]["criteria"]:
            raise ValueError(f"unexpected choice {a['choice']!r}")
        p = round(a["probabilities"][a["choice"]], 3)
        result.update(choice=a["choice"], page_turn=a["choice"] == "page_turn" and p >= TURN_P, p=p)
    except Exception as e:
        result["error"] = repr(e)[:200]
    label = "error" if result["error"] else f"{result['choice']}_p{result['p']}"  # page_turn / no_turn / unclear
    result["saved"] = save_sheet(sheet, page, reading, label)
    return result


def save_sheet(sheet, page, reading, label):
    """Write a sheet to output/turn_sheets/<reading>/; returns its repo-relative path"""
    # ponytail: sheets are kept forever (~100 KB each)
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


@functools.lru_cache(maxsize=256)
def _cached_features(path, mtime):  # mtime is only part of the cache key
    return _features(path)


def _fingerprint(path):
    """A stored page image's features, computed once per version of the file (mtime: a re-scan isn't served stale)."""
    return _cached_features(path, os.path.getmtime(path))


def _page_check(photo_path, page_paths, page):
    """This page or the next? Per page {inliers, good, total}; stays on `page` without 25+ inliers."""
    kp, des = _features(photo_path)
    matcher = cv2.BFMatcher(cv2.NORM_HAMMING)
    scores = {}
    for i in (page, page + 1):
        if i >= len(page_paths) or not os.path.isfile(page_paths[i]):
            continue
        kp2, des2 = _fingerprint(page_paths[i])
        scores[i] = {"inliers": 0, "good": 0, "total": len(kp2)}
        if des is None or des2 is None or len(des2) < 2:
            continue
        good = [m[0] for m in matcher.knnMatch(des, des2, k=2) if len(m) == 2 and m[0].distance < 0.75 * m[1].distance]
        scores[i]["good"] = len(good)
        if len(good) < 4:  # findHomography needs 4 points
            continue
        _, mask = cv2.findHomography(np.float32([kp[m.queryIdx].pt for m in good]),
                                     np.float32([kp2[m.trainIdx].pt for m in good]), cv2.RANSAC, 5.0)
        scores[i]["inliers"] = int(mask.sum()) if mask is not None else 0
    best = max(scores, key=lambda i: scores[i]["inliers"], default=page)
    # ponytail: fixed 25-inlier cutoff
    return (best if best in scores and scores[best]["inliers"] >= 25 else page), scores


def version_check(photo_path, versions, page):
    """The photo as taken against reading versions, newest first; the first with 25 inliers decides. None if none."""
    # ponytail: every version is tried; limit to the newest few if replies get slow
    mine = [list(v) for v in versions]
    for k in range(max((len(mine[i]) for i in (page, page + 1) if i < len(mine)), default=0)):
        paths = [v[k] if k < len(v) else "" for v in mine]  # "": no k-th version, skipped like a missing file
        v_best, v_scores = _page_check(photo_path, paths, page)
        if any(s["inliers"] >= 25 for s in v_scores.values()):
            return v_best, v_scores, os.path.basename(paths[max(v_scores, key=lambda i: v_scores[i]["inliers"])])
    return None


@router.post("/turn")
async def turn(request: Request, book: str = Query(pattern=BOOK_ID), page: int = Query(ge=0), reading: str = ""):
    """POST a photo of the open book; replies {page, scores, version, times}"""
    times = {}
    with timed(times, "upload"):
        photo = await request.body()
    try:
        best, scores, version = await run_in_threadpool(page_after_turn, book, page, photo, times)
    except Exception as e:
        traceback.print_exc()
        report(book, f"turn from {page} FAILED", times)
        reading_log.log(reading, "turn failed", f"{e!r} | {times}")
        raise HTTPException(500, str(e))
    report(book, f"turn {page} -> {best}{f' (version {version})' if version else ''}", times)
    reading_log.log(reading, "turn", f"on page {page} -> {best}, version {version}, scores {scores} | {times}")
    return {"page": best, "scores": scores, "version": version, "times": times}


@router.post("/turn/decide")
async def turn_decide(request: Request, book: str = Query(pattern=BOOK_ID), page: int = Query(ge=0), reading: str = ""):
    """POST a 10-frame sheet; replies the decision model's {choice, page_turn, p, error, saved, times}"""
    times = {}
    with timed(times, "upload"):
        sheet = await request.body()
    result = await run_in_threadpool(sheet_decision, sheet, page, reading, times)
    report(book, f"turn decide on {page} -> {result['error'] or result['choice']}", times)
    reading_log.log(reading, "turn decide", f"on page {page} -> {result} | {times}")
    return {**result, "times": times}


@router.post("/turn/sheet")
async def turn_sheet(request: Request, book: str = Query(pattern=BOOK_ID), page: int = Query(ge=0), reading: str = "",
                     motion: float = Query(0, ge=0, le=100), trigger: str = Query("motion", pattern=r"^[a-z]{1,20}$")):
    """Save a sheet only (no model call). Replies {"saved": path}."""
    sheet = await request.body()
    saved = await run_in_threadpool(save_sheet, sheet, page, reading, f"{trigger}_motion{motion:.0f}")
    reading_log.log(reading, "turn sheet", f"on page {page}, {trigger}, motion {motion:.1f} -> {saved}")
    return {"saved": saved}
