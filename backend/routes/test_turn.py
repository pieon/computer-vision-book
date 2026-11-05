"""Check for /turn's image matching on real scans. Run from the repo root: python -m backend.routes.test_turn"""
import os
import tempfile

import cv2
import numpy as np

from backend.config import IMG_DIR
from backend.routes.scan import image_page_check


def test_image_page_check():
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
        best, scores = image_page_check(photo, [a, b], 0)
        assert best == 1, scores  # turned to the next page
        assert image_page_check(photo, [b, a], 0)[0] == 0, scores  # still on this page
        assert image_page_check(blank, [a, b], 0)[0] == 0  # nothing recognisable: stay
    print("ok", scores)


if __name__ == "__main__":
    test_image_page_check()
