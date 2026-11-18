"""Visual walk-through of /turn's ORB page check (same steps and numbers as image_page_check in backend/routes/scan.py).
Run from the repo root: python orb_demo/orb_demo.py [book_dir] [page_index]
Writes 1_keypoints.png, 2_fingerprint.png, 3_match_right.png, 4_match_wrong.png next to this file."""
import os
import sys

import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
book = sys.argv[1] if len(sys.argv) > 1 else "output/books/NkwYVx2vp3"
i = int(sys.argv[2]) if len(sys.argv) > 2 else 2
pages = sorted(os.path.join(book, f) for f in os.listdir(book))
right_path, wrong_path = pages[i], pages[i + 1]


def gray800(img):
    img = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY) if img.ndim == 3 else img
    return cv2.resize(img, (800, round(img.shape[0] * 800 / img.shape[1])))


def fake_photo(img):
    """The scan as a phone might see it again: tilted, slightly skewed, darker, a bit blurry."""
    h, w = img.shape[:2]
    m = cv2.getRotationMatrix2D((w / 2, h / 2), 6, 1)
    img = cv2.warpAffine(img, m, (w, h), borderValue=(255, 255, 255))
    src = np.float32([[0, 0], [w, 0], [w, h], [0, h]])
    dst = np.float32([[w * .03, h * .02], [w * .98, 0], [w, h], [0, h * .97]])
    img = cv2.warpPerspective(img, cv2.getPerspectiveTransform(src, dst), (w, h), borderValue=(255, 255, 255))
    return cv2.GaussianBlur(cv2.convertScaleAbs(img, alpha=0.8), (5, 5), 0)


photo = gray800(fake_photo(cv2.imread(right_path)))
orb = cv2.ORB_create(1500)
kp, des = orb.detectAndCompute(photo, None)


def match(scan):
    """Steps 4-5 exactly as image_page_check: kNN k=2, ratio 0.75, RANSAC 5 px. Returns (kp2, good, inlier mask)."""
    kp2, des2 = orb.detectAndCompute(scan, None)
    good = [m[0] for m in cv2.BFMatcher(cv2.NORM_HAMMING).knnMatch(des, des2, k=2)
            if len(m) == 2 and m[0].distance < 0.75 * m[1].distance]
    mask = np.zeros(len(good), bool)
    if len(good) >= 4:
        _, mk = cv2.findHomography(np.float32([kp[m.queryIdx].pt for m in good]),
                                   np.float32([kp2[m.trainIdx].pt for m in good]), cv2.RANSAC, 5.0)
        if mk is not None:
            mask = mk.ravel().astype(bool)
    return kp2, des2, good, mask


def banner(img, lines, h=34):
    img = cv2.cvtColor(img, cv2.COLOR_GRAY2BGR) if img.ndim == 2 else img
    top = np.full((h * len(lines) + 10, img.shape[1], 3), 255, np.uint8)
    for n, t in enumerate(lines):
        cv2.putText(top, t, (10, h * (n + 1)), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 0, 0), 2, cv2.LINE_AA)
    return np.vstack([top, img])


def draw_matches(scan, kp2, good, mask, title):
    a, b = cv2.cvtColor(photo, cv2.COLOR_GRAY2BGR), cv2.cvtColor(scan, cv2.COLOR_GRAY2BGR)
    h = max(a.shape[0], b.shape[0])
    a, b = [cv2.copyMakeBorder(x, 0, h - x.shape[0], 0, 20, cv2.BORDER_CONSTANT, value=(255, 255, 255)) for x in (a, b)]
    canvas = np.hstack([a, b])
    off = a.shape[1]
    for m, ok in sorted(zip(good, mask), key=lambda t: t[1]):  # inliers drawn last, on top
        p = tuple(map(int, kp[m.queryIdx].pt))
        q = (int(kp2[m.trainIdx].pt[0]) + off, int(kp2[m.trainIdx].pt[1]))
        c = (0, 170, 0) if ok else (0, 0, 230)
        cv2.line(canvas, p, q, c, 1, cv2.LINE_AA)
        cv2.circle(canvas, p, 4, c, 2)
        cv2.circle(canvas, q, 4, c, 2)
    n = int(mask.sum())
    return banner(canvas, [title,
                           f"good matches (passed ratio test): {len(good)}   inliers (green, line up as one page): {n}"
                           f"   outliers (red): {len(good) - n}",
                           f"score = {n}  ->  {'PASSES' if n >= 25 else 'below'} the 25-inlier cutoff"])


# 1. keypoints: circle size = keypoint scale, line = orientation (step 2's arrow)
kp_img = cv2.drawKeypoints(photo, kp, None, (0, 140, 255), cv2.DRAW_MATCHES_FLAGS_DRAW_RICH_KEYPOINTS)
cv2.imwrite(os.path.join(HERE, "1_keypoints.png"),
            banner(kp_img, [f"Photo: {len(kp)} ORB keypoints (FAST corners)",
                            "circle = size the corner was found at, line = its direction"]))

# 2. one matched corner's fingerprint in photo vs scan
scan_r = gray800(cv2.imread(right_path))
kp2, des2, good, mask = match(scan_r)
best = min((m for m, ok in zip(good, mask) if ok), key=lambda m: m.distance)
bits_a = np.unpackbits(des[best.queryIdx])
bits_b = np.unpackbits(des2[best.trainIdx])
_, des_w = orb.detectAndCompute(gray800(cv2.imread(wrong_path)), None)
rand = des_w[len(des_w) // 2]  # some corner from the other page, for contrast
bits_c = np.unpackbits(rand)


def patch(img, k, px=31 * 8):
    s = max(31, int(k.size))  # the square ORB looked at, in this image's pixels
    x, y = map(int, k.pt)
    p = cv2.copyMakeBorder(img, s, s, s, s, cv2.BORDER_REPLICATE)[y + s - s // 2:y + s + s // 2 + 1,
                                                                   x + s - s // 2:x + s + s // 2 + 1]
    p = cv2.cvtColor(cv2.resize(p, (px, px), interpolation=cv2.INTER_NEAREST), cv2.COLOR_GRAY2BGR)
    c = px // 2
    cv2.arrowedLine(p, (c, c), (int(c + 0.4 * px * np.cos(np.radians(k.angle))),
                                int(c + 0.4 * px * np.sin(np.radians(k.angle)))), (0, 140, 255), 3, tipLength=0.2)
    return p


def grid(bits, diff=None, cell=15):
    g = np.full((16 * cell, 16 * cell, 3), 255, np.uint8)
    for n, b in enumerate(bits):
        r, c = divmod(n, 16)
        col = (0, 0, 230) if diff is not None and diff[n] else ((30, 30, 30) if b else (235, 235, 235))
        cv2.rectangle(g, (c * cell + 1, r * cell + 1), ((c + 1) * cell - 1, (r + 1) * cell - 1), col, -1)
    return g


def labeled(img, text, w=280):
    img = cv2.copyMakeBorder(img, 0, 0, 0, max(0, w - img.shape[1]), cv2.BORDER_CONSTANT, value=(255, 255, 255))
    return banner(img, [text], h=28)


row = [labeled(patch(photo, kp[best.queryIdx]), "photo corner"),
       labeled(grid(bits_a), "photo fingerprint"),
       labeled(patch(scan_r, kp2[best.trainIdx]), "scan corner"),
       labeled(grid(bits_b), "scan fingerprint"),
       labeled(grid(bits_a, bits_a != bits_b), f"diff: {int((bits_a != bits_b).sum())}/256"),
       labeled(grid(bits_a, bits_a != bits_c), f"vs other page: {int((bits_a != bits_c).sum())}")]
hmax = max(r.shape[0] for r in row)
row = np.hstack([cv2.copyMakeBorder(r, 0, hmax - r.shape[0], 0, 20, cv2.BORDER_CONSTANT, value=(255, 255, 255))
                 for r in row])
hexa = des[best.queryIdx].tobytes().hex()
cv2.imwrite(os.path.join(HERE, "2_fingerprint.png"), banner(row, [
    "One corner's 256-bit fingerprint (16x16 grid, read left to right, top to bottom; dark = 1, light = 0)",
    f"photo bytes: {hexa[:32]}", f"             {hexa[32:]}",
    "red = bits that differ.  Same corner: few differ.  Unrelated corner: about half (~128) differ."]))

# 3-4. matching against the right page and the next (wrong) page
cv2.imwrite(os.path.join(HERE, "3_match_right.png"),
            draw_matches(scan_r, kp2, good, mask, f"Photo (left) vs SAME page scan {os.path.basename(right_path)} (right)"))
scan_w = gray800(cv2.imread(wrong_path))
kpw, _, good_w, mask_w = match(scan_w)
cv2.imwrite(os.path.join(HERE, "4_match_wrong.png"),
            draw_matches(scan_w, kpw, good_w, mask_w, f"Photo (left) vs NEXT page scan {os.path.basename(wrong_path)} (right)"))

s_r, s_w = int(mask.sum()), int(mask_w.sum())
print(f"photo keypoints: {len(kp)}")
print(f"right page {os.path.basename(right_path)}: {len(good)} good matches, {s_r} inliers")
print(f"next page  {os.path.basename(wrong_path)}: {len(good_w)} good matches, {s_w} inliers")
print(f"example corner: same-spot distance {int((bits_a != bits_b).sum())}/256, other-page distance {int((bits_a != bits_c).sum())}/256")
print(f"photo fingerprint: {hexa}")
print("decision:", os.path.basename(right_path) if max(s_r, s_w) >= 25 and s_r >= s_w else "next page/stay")
