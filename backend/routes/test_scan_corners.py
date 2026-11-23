"""Check for the Scanner's four-corner straightening. Run from the repo root: python -m backend.routes.test_scan_corners"""
import os
import tempfile

import cv2
import numpy as np

from backend.routes.scan import straighten
from backend.routes.test_turn import most_pages
from backend.routes.turn import _page_check


def test_straighten():
    page = most_pages()[1]
    img = cv2.imread(page)
    h, w = img.shape[:2]
    W, H = w * 2, h * 2
    # the page as a tilted camera would see it: a quad on a bigger grey frame
    quad = np.float32([[0.30 * W, 0.20 * H], [0.75 * W, 0.25 * H], [0.80 * W, 0.80 * H], [0.20 * W, 0.70 * H]])
    m = cv2.getPerspectiveTransform(np.float32([[0, 0], [w, 0], [w, h], [0, h]]), quad)
    photo = cv2.warpPerspective(img, m, (W, H), borderValue=(128, 128, 128))
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "photo.jpg")
        cv2.imwrite(path, photo)
        corners = (quad[[2, 0, 3, 1]] / [W, H]).ravel().tolist()  # any order
        straighten(path, corners)
        out = cv2.imread(path)
        oh, ow = out.shape[:2]
        assert abs(ow / oh - w / h) / (w / h) < 0.15, (ow, oh, w, h)  # about the page's shape again
        best, scores = _page_check(path, [page], 0)
        assert scores[0]["inliers"] >= 100, scores  # the same page, upright
        before = os.path.getsize(path)
        straighten(path, [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.51, 0.51])  # degenerate: left alone
        assert os.path.getsize(path) == before
    print("ok corners", (ow, oh), scores[0])


if __name__ == "__main__":
    test_straighten()
