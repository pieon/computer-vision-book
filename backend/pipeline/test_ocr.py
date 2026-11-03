"""Live tests for ocr.py (call the VT LLM API). Run from the repo root: python -m backend.pipeline.test_ocr"""
import os

from backend.clients.arc import chat
from backend.config import ROOT
from backend.pipeline.ocr import ocr

IMG = os.path.join(ROOT, "output", "IMG_0003_unwarp.png")  # made by scripts/build_book.py (raw photos are mirrored)
EXPECTED = "and then he ate my tie"


def test_chat():
    reply = chat("Reply with exactly the word: pong")
    assert "pong" in reply.lower(), reply


def test_ocr():
    text = ocr(IMG)
    assert EXPECTED in " ".join(text.lower().split()), text


if __name__ == "__main__":
    if not os.environ.get("LLM_API_KEY"):
        raise SystemExit("LLM_API_KEY not set: add it to .env")
    test_chat()
    print("test_chat ok")
    if os.path.exists(IMG):
        test_ocr()
        print("test_ocr ok")
    else:
        print(f"test_ocr skipped: {IMG} missing (run scripts/build_book.py first)")
