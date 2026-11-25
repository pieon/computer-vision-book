"""Sound effects (Freesound or ElevenLabs, backend/pipeline/book/sounds.py). POST /books/<id>/sounds picks sounds for a book's
pages that have none (?all=true: every page again); POST / DELETE /books/<id>/pages/<key>/sounds...: Edit Book's
review (pick a page again, remove one sound); GET /sounds/cues: the reader's fixed cue sounds;
GET /sounds/file/<id>.mp3: a picked sound's preview, served from here so the app's Web Audio can play it (same origin)."""
from fastapi import APIRouter, HTTPException, Path, Query
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse

from backend.clients import elevenlabs, freesound
from backend.db import BOOK_ID, books, lock
from backend.pipeline.book.sounds import set_page_sounds, source

router = APIRouter()
CUES = {"turn": "page turn", "end": "magic chime", "ask": "curious hmm"}  # Book.jsx: page turned, book done, "see the book"
PAGE_KEY = r"^(Cover|Page[A-Za-z]+)$"  # no . or $: safe in a dotted Mongo path
SLOT = r"^(setting|[0-9]{1,3})$"  # the background, or a line index


def _page(book_id, key):
    doc = books.find_one({"_id": book_id}, {"book": 1})
    page = doc and doc["book"][0]["Book"]["Pages"].get(key)
    if not page:
        raise HTTPException(404, "no such page")
    return page


@router.post("/books/{book_id}/sounds")
async def pick_book_sounds(book_id: str = Path(pattern=BOOK_ID), all: bool = False):
    """Pick sounds for every page without them (all=true: every page, replacing its sounds), one page after another
    (Freesound allows 60 searches a minute). Waits until done; replies {"picked": number of pages}."""
    doc = books.find_one({"_id": book_id}, {"book": 1})
    if not doc:
        raise HTTPException(404, "no such book")
    todo = [p for p in doc["book"][0]["Book"]["Pages"].values() if all or "sounds" not in p]
    for p in todo:
        await run_in_threadpool(set_page_sounds, book_id, p["img"], p["text"])
    return {"picked": len(todo)}


@router.post("/books/{book_id}/pages/{key}/sounds")
async def pick_page_sounds(book_id: str = Path(pattern=BOOK_ID), key: str = Path(pattern=PAGE_KEY)):
    """Edit Book's "Pick again": pick this page's sounds now (a few seconds) and reply with them."""
    page = _page(book_id, key)
    sounds = await run_in_threadpool(set_page_sounds, book_id, page["img"], page["text"])
    if sounds is None:
        raise HTTPException(409, "the page changed meanwhile; try again")
    return sounds


@router.delete("/books/{book_id}/pages/{key}/sounds/{slot}")
def remove_sound(book_id: str = Path(pattern=BOOK_ID), key: str = Path(pattern=PAGE_KEY), slot: str = Path(pattern=SLOT)):
    """Edit Book's "Remove": drop the page's background ("setting") or a line's effect, and never pick that sound for
    this book again (blockedSounds). Replies with the page's sounds."""
    path = f"book.0.Book.Pages.{key}.sounds"
    with lock:
        sounds = _page(book_id, key).get("sounds") or {"setting": None, "lines": {}}
        gone = sounds["setting"] if slot == "setting" else sounds["lines"].pop(slot, None)
        if slot == "setting":
            sounds["setting"] = None
        if gone:
            books.update_one({"_id": book_id}, {"$set": {path: sounds}, "$addToSet": {"blockedSounds": gone["id"]}})
    return sounds


@router.get("/sounds/cues")
async def cues():
    """{"turn" | "end" | "ask": sound or null}, searched once and then cached."""
    return {k: await run_in_threadpool(source().find, q, "effect") for k, q in CUES.items()}


@router.get("/sounds/file/{sound_id}.mp3")
async def sound_file(sound_id: str = Path(pattern=r"^([0-9]{1,12}|el[0-9a-f]{12})$")):
    """A picked sound's preview MP3. Freesound's terms allow keeping copies only while needed: output/sfx/ is a cache,
    safe to delete. ponytail: kept forever otherwise."""
    try:
        # by the id, not SOUND_SOURCE: a page's stored sounds play whichever source is switched on now
        path = (elevenlabs.download(sound_id) if sound_id.startswith("el")
                else await run_in_threadpool(freesound.download, int(sound_id)))
    except Exception as e:
        raise HTTPException(502, f"couldn't fetch the sound: {e}") from e
    if not path:
        raise HTTPException(404, "no such sound")
    return FileResponse(path, media_type="audio/mpeg")
