"""Extract text from an image via VT ARC's LLM API. Usage: python -m backend.pipeline.ocr image.jpg"""
import base64
import mimetypes
import sys

from backend.clients.arc import chat


def ocr(path):
    """Send the image to the LLM and return the extracted text."""
    mime = mimetypes.guess_type(path)[0] or "image/jpeg"
    with open(path, "rb") as f:
        b64 = base64.b64encode(f.read()).decode()
    return chat([
        {"type": "text", "text": "Extract main text in this image verbatim. Output only the text."},
        {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{b64}"}},
    ])


if __name__ == "__main__":
    path = sys.argv[1]
    text = ocr(path)
    print(text)
