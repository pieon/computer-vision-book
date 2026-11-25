"""Deleting a book drops its unshared sounds and clips. Run: python -m backend.routes.test_delete_files"""
import os
import tempfile

from backend.clients import elevenlabs, vertex
from backend.db import books
from backend.routes.books import delete_book
from backend.routes.tts import VOICES

A, B = "zz-del-a", "zz-del-b"
CUE = elevenlabs.sound_id("page turn", "effect")  # a reader cue: kept even if a deleted book used it


def book(lines, sound_ids):
    page = {"img": "p.png", "text": [{"Character": "Narrator", "Dialogue": t} for t in lines],
            "sounds": {"setting": {"id": sound_ids[0]}, "lines": {str(i): {"id": s} for i, s in enumerate(sound_ids[1:])}}}
    return {"book": [{"Book": {"Name": "test", "Pages": {"Cover": page}}}]}


def touch(path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    open(path, "w").close()


def test_delete_files():
    elevenlabs.FILE_DIR = tempfile.mkdtemp()
    vertex.CACHE_DIR = tempfile.mkdtemp()
    sfx = lambda s: os.path.join(elevenlabs.FILE_DIR, f"{s}.mp3")
    books.insert_one({"_id": A, **book(["Only in A.", "The End."], ["elaaaaaaaaaaaa", 111, CUE])})
    books.insert_one({"_id": B, **book(["Only in B.", "The End."], ["elbbbbbbbbbbbb", 111])})
    try:
        for s in ["elaaaaaaaaaaaa", 111, CUE, "elbbbbbbbbbbbb"]:
            touch(sfx(s))
        for t in ["Only in A.", "The End.", "Only in B."]:
            for v in VOICES.values():
                touch(vertex.clip_path(t, v))
        delete_book(A)
        assert not os.path.exists(sfx("elaaaaaaaaaaaa"))  # A's own sound
        assert all(not os.path.exists(vertex.clip_path("Only in A.", v)) for v in VOICES.values())  # every voice
        assert os.path.exists(sfx(111)) and os.path.exists(sfx("elbbbbbbbbbbbb"))  # shared with B / B's own
        assert os.path.exists(sfx(CUE))  # a cue sound
        assert all(os.path.exists(vertex.clip_path(t, v)) for t in ["The End.", "Only in B."] for v in VOICES.values())
    finally:
        books.delete_many({"_id": {"$in": [A, B]}})


if __name__ == "__main__":
    test_delete_files()
    print("ok delete files")
