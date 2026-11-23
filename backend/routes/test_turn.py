"""Check for /turn's image matching on real scans. Run from the repo root: python -m backend.routes.test_turn"""
import os
import tempfile

import cv2
import numpy as np

from backend.config import IMG_DIR
from backend.routes.turn import _page_check, version_check


def test_page_check():
    book = max(os.listdir(IMG_DIR), key=lambda d: len(os.listdir(os.path.join(IMG_DIR, d))))  # most pages
    a, b = sorted(os.path.join(IMG_DIR, book, f) for f in os.listdir(os.path.join(IMG_DIR, book)))[1:3]
    img = cv2.imread(b)
    h, w = img.shape[:2]
    # page B as a fresh photo would differ: slightly rotated and darker
    moved = cv2.convertScaleAbs(cv2.warpAffine(img, cv2.getRotationMatrix2D((w / 2, h / 2), 3, 1), (w, h)), alpha=0.8)
    with tempfile.TemporaryDirectory() as tmp:
        photo, blank = os.path.join(tmp, "photo.png"), os.path.join(tmp, "blank.png")
        cv2.imwrite(photo, moved)
        cv2.imwrite(blank, np.full((h, w, 3), 200, np.uint8))
        best, scores = _page_check(photo, [a, b], 0)
        assert best == 1, scores  # turned to the next page
        assert _page_check(photo, [b, a], 0)[0] == 0, scores  # still on this page
        assert _page_check(blank, [a, b], 0)[0] == 0  # nothing recognisable: stay
        # a version of the next page matches: that version decides; older ones are tried too
        best, v_scores, version = version_check(photo, [[blank], [blank, b]], 0)
        assert (best, version) == (1, os.path.basename(b)), (v_scores, version)
        assert version_check(photo, [[blank], [blank]], 0) is None  # none match: unsure
        assert version_check(photo, [[], []], 0) is None  # no versions
    print("ok", scores)


def test_sheet_decision():
    """Each decision-model answer maps to the reply and file name the reader expects; only "page_turn" with p >= TURN_P turns.
    The model is faked, so no network."""
    import asyncio
    import shutil

    from backend.routes import turn

    reading = "zz-test-decide"
    real = turn.decide
    try:
        for choice, turned in (("page_turn", True), ("no_turn", False), ("unclear", False)):
            turn.decide = lambda state, q, images, c=choice: {"turn": {"choice": c, "probabilities": {c: 0.91}}}
            r = turn.sheet_decision(b"jpeg", 2, reading, {})
            assert (r["choice"], r["page_turn"], r["p"], r["error"]) == (choice, turned, 0.91, None), r
            assert r["saved"].endswith(f"_p3_{choice}_p0.91.jpg"), r["saved"]
        turn.decide = lambda state, q, images: {"turn": {"choice": "page_turn", "probabilities": {"page_turn": 0.64}}}
        r = turn.sheet_decision(b"jpeg", 0, reading, {})  # page_turn, but not sure enough: no turn, choice still shown
        assert (r["choice"], r["page_turn"], r["p"]) == ("page_turn", False, 0.64), r
        assert r["saved"].endswith("_page_turn_p0.64.jpg"), r["saved"]
        turn.decide = lambda state, q, images: {"turn": {"choice": "moving", "probabilities": {"moving": 1}}}
        r = turn.sheet_decision(b"jpeg", 0, reading, {})  # an answer outside the criteria: an error, not a turn
        assert r["error"] and not r["page_turn"] and r["saved"].endswith("_error.jpg"), r

        class Body:
            async def body(self):
                return b"jpeg"
        turn.decide = lambda state, q, images: {"turn": {"choice": "unclear", "probabilities": {"unclear": 0.5}}}
        reply = asyncio.run(turn.turn_decide(Body(), "zz-test-id", 0, reading))  # the route used to KeyError here
        assert reply["choice"] == "unclear" and reply["page_turn"] is False, reply
    finally:
        turn.decide = real
        shutil.rmtree(os.path.join(turn.SHEET_DIR, reading), ignore_errors=True)
    print("ok decision")


def test_versions():
    """add_version saves the photo as sent (no unwarp) into <book>/alt/ without touching the DB; version_paths lists a
    page's versions newest first, old .png and new .jpg, and not another page's whose name starts the same
    (page_002 vs page_002_1)."""
    from backend.routes import scan

    book = max(os.listdir(IMG_DIR), key=lambda d: len(os.listdir(os.path.join(IMG_DIR, d))))
    photo_src = sorted(f for f in os.listdir(os.path.join(IMG_DIR, book)) if f.endswith(".png"))[1]
    with open(os.path.join(IMG_DIR, book, photo_src), "rb") as f:
        photo = f.read()
    real_dir, real_books = scan.IMG_DIR, scan.books

    class Books:  # one book, pages page_002.png and page_002_1.png; no writes allowed
        def find_one(self, *_):
            return {"book": [{"Book": {"Pages": {"Cover": {"img": "page_002.png"}, "PageOne": {"img": "page_002_1.png"}}}}]}
    with tempfile.TemporaryDirectory() as tmp:
        scan.IMG_DIR, scan.books = tmp, Books()
        try:
            first = scan.add_version("zz", 0, photo, {})
            second = scan.add_version("zz", 0, photo, {})
            other = scan.add_version("zz", 1, photo, {})
            assert scan.add_version("zz", 2, photo, {}) is None  # no such page
            old = os.path.join(tmp, "zz", "alt", "page_002_20200101-000000-000000.png")  # an unwarped one from before
            open(old, "wb").close()
            assert scan.version_paths("zz", "page_002.png") == [second, first, old], os.listdir(os.path.dirname(first))
            assert scan.version_paths("zz", "page_002_1.png") == [other]
            assert first.endswith(".jpg") and open(first, "rb").read() == photo  # kept as taken
        finally:
            scan.IMG_DIR, scan.books = real_dir, real_books
    print("ok versions")


if __name__ == "__main__":
    test_page_check()
    test_versions()
    test_sheet_decision()
