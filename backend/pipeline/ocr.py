"""Extract text from an image via VT ARC's LLM API. Usage: python -m backend.pipeline.ocr image.jpg"""
import base64
import sys

import cv2

from backend.clients.arc import chat


def jpeg_data_url(path, max_side=None):
    """An image file (e.g. a stored page_00N.png) as a "data:image/jpeg;base64,..." URL for an LLM request, made in
    memory; the file on disk stays as it is. JPEG quality 85: a page photo is ~10x smaller than the PNG (2385 KB ->
    237 KB), so it gets to the API much faster. max_side: shrink so the longer side is at most this many pixels."""
    img = cv2.imread(path)
    if img is None:
        raise FileNotFoundError(f"Could not read image: {path}")
    if max_side and max(img.shape[:2]) > max_side:
        scale = max_side / max(img.shape[:2])
        img = cv2.resize(img, (round(img.shape[1] * scale), round(img.shape[0] * scale)), interpolation=cv2.INTER_AREA)
    ok, jpg = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 85])
    if not ok:
        raise ValueError(f"Could not encode {path} as JPEG")
    return f"data:image/jpeg;base64,{base64.b64encode(jpg.tobytes()).decode()}"


def ocr(path):
    """Send the image (as JPEG, full size) to the LLM and return the extracted text."""
    return chat([
        {"type": "text", "text": "Extract main text in this image verbatim. Output only the text."},
        {"type": "image_url", "image_url": {"url": jpeg_data_url(path)}},
    ])


if __name__ == "__main__":
    path = sys.argv[1]
    text = ocr(path)
    print(text)
