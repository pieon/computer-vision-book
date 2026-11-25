"""The library: list books, one book's JSON, edit a page's lines, delete a book."""
import os
import shutil
import time
from datetime import datetime, timezone
from typing import Annotated

from fastapi import APIRouter, HTTPException, Path, Query, Request
from pydantic import BaseModel, Field, StringConstraints

from backend.config import IMG_DIR
from backend.db import BOOK_ID, books, deleted, lock
from backend.pipeline.book.book_builder import book_json, cover_title, page_key
from backend.clients import elevenlabs, freesound, vertex
from backend.pipeline.book.sounds import pick_later, voiced_lines
from backend.routes.scan import version_paths
from backend.routes.sounds import CUES
from backend.routes.tts import VOICES

router = APIRouter()


class Line(BaseModel):
    Character: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=40)]
    Dialogue: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=2000)]


class PageEdit(BaseModel):
    text: list[Line] = Field(max_length=200)


class Flag(BaseModel):
    flagged: bool


class PageOrder(BaseModel):
    order: list[str] = Field(max_length=1000)  # every page key once, in the new order


Voice = Annotated[str, StringConstraints(max_length=40)]


class Reading(BaseModel):
    page: int = Field(ge=0, le=999)  # page index being read
    finished: bool  # the book's last line was read
    cast: dict[Voice, Voice] = Field(max_length=100)  # {character: voice, "" = read by the reader} (Cast.jsx)


@router.get("/books")
def list_books():
    """Library tiles, newest first; unknown = page numbers with an "Unknown" speaker"""
    rows = list(books.aggregate([
        {"$sort": {"createdAt": -1}},
        {"$project": {"_id": 0, "id": "$_id", "name": {"$first": "$book.Book.Name"},
                      "pages": {"$size": {"$filter": {"input": "$texts", "cond": {"$ne": ["$$this", None]}}}},  # pages done so far, "createdAt": 1,
                      "cover": {"$first": "$book.Book.Pages.Cover.img"},
                      # each page's speakers, in page order
                      "speakers": {"$map": {"input": {"$objectToArray": {"$first": "$book.Book.Pages"}},
                                            "in": "$$this.v.text.Character"}},
                      # each page's reader flag (Book.jsx), in page order
                      "flags": {"$map": {"input": {"$objectToArray": {"$first": "$book.Book.Pages"}},
                                         "in": "$$this.v.flagged"}}}},
    ]))
    for r in rows:
        r["unknown"] = [i + 1 for i, s in enumerate(r.pop("speakers", None) or []) if "Unknown" in s]
        r["flagged"] = [i + 1 for i, f in enumerate(r.pop("flags", None) or []) if f]
    return rows


@router.get("/books/{book_id}")
def get_book(book_id: str = Path(pattern=BOOK_ID)):
    """One book's Book2 JSON, as stored."""
    doc = books.find_one({"_id": book_id}, {"book": 1})
    if not doc:
        raise HTTPException(404, "no such book")
    return doc["book"]


@router.put("/books/{book_id}/reading", status_code=204)
def save_reading(r: Reading, book_id: str = Path(pattern=BOOK_ID)):
    """Save where reading is and the voices, for Home's Last Read Book"""
    done = books.update_one({"_id": book_id}, {"$set": {"lastRead": {**r.model_dump(), "at": datetime.now(timezone.utc)}}})
    if not done.matched_count:
        raise HTTPException(404, "no such book")


@router.get("/books/{book_id}/progress")
def scan_progress(book_id: str = Path(pattern=BOOK_ID), n: str = Query(pattern=r"^[0-9]{1,3}(,[0-9]{1,3}){0,999}$")):
    """Progress of pages `n`: {n: {text, sounds, voice: [made, total]}}, from the DB and the clip cache"""
    doc = books.find_one({"_id": book_id}, {"book": 1})
    pages = doc["book"][0]["Book"]["Pages"] if doc else {}
    out = {}
    for i in map(int, n.split(",")):
        page = pages.get(page_key(i))
        lines = voiced_lines(page["text"]) if page else []
        out[i] = {"text": bool(page), "sounds": bool(page) and "sounds" in page,
                  "voice": [sum(os.path.exists(vertex.clip_path(t)) for t in lines), len(lines)]}
    return out


@router.put("/books/{book_id}/pages/{key}")
def edit_page(edit: PageEdit, book_id: str = Path(pattern=BOOK_ID), key: str = Path(pattern=r"^(Cover|Page[A-Za-z]+)$")):
    """Edit Book: replace one page's lines; Characters is rebuilt. Replies with the book."""
    with lock:  # not while a scanned page is being added to it
        doc = books.find_one({"_id": book_id}, {"book": 1})
        pages = doc and doc["book"][0]["Book"]["Pages"]
        if not pages or key not in pages:
            raise HTTPException(404, "no such page")
        pages[key]["text"] = [{"Reading": False, "Character": l.Character, "Dialogue": l.Dialogue} for l in edit.text]
        name = doc["book"][0]["Book"]["Name"]
        if key == "Cover":  # the title follows the cover's lines; this is the only way to change it
            name = cover_title(pages[key]) or name
        book = book_json(name, pages, [], doc["book"][0]["Book"]["Characters"])
        books.update_one({"_id": book_id}, {"$set": {"book": book, "updatedAt": datetime.now(timezone.utc)}})
    pick_later(book_id, pages[key])  # the lines changed: so may their sounds
    return book


@router.put("/books/{book_id}/pages/{key}/flag")
def flag_page(flag: Flag, book_id: str = Path(pattern=BOOK_ID), key: str = Path(pattern=r"^(Cover|Page[A-Za-z]+)$")):
    """Flag or unflag a page as needing a fix"""
    path = f"book.0.Book.Pages.{key}"
    with lock:
        r = books.update_one({"_id": book_id, path: {"$exists": True}}, {"$set": {f"{path}.flagged": flag.flagged}})
    if not r.matched_count:
        raise HTTPException(404, "no such page")
    return {"flagged": flag.flagged}


@router.put("/books/{book_id}/face")
async def set_face(request: Request, book_id: str = Path(pattern=BOOK_ID), name: str = Query(min_length=1)):
    """Save a character's cropped face (JPEG), replacing the old file. Replies {"img"}.
    ponytail: a dropped character's face file stays until the book is deleted"""
    jpeg = await request.body()
    if not jpeg.startswith(b"\xff\xd8") or len(jpeg) > 2_000_000:
        raise HTTPException(400, "send a JPEG under 2 MB")
    img = f"face_{int(time.time() * 1000)}.jpg"
    with lock:
        doc = books.find_one({"_id": book_id}, {"book": 1})
        chars = doc["book"][0]["Book"]["Characters"] if doc else []
        i = next((i for i, c in enumerate(chars) if c["Name"] == name), None)
        if i is None:
            raise HTTPException(404, "no such character")
        folder = os.path.join(IMG_DIR, book_id)
        os.makedirs(folder, exist_ok=True)
        with open(os.path.join(folder, img), "wb") as f:
            f.write(jpeg)
        books.update_one({"_id": book_id}, {"$set": {f"book.0.Book.Characters.{i}.img": img,
                                                     "updatedAt": datetime.now(timezone.utc)}})
    old = os.path.join(folder, os.path.basename(chars[i].get("img") or ""))
    if os.path.isfile(old):
        os.remove(old)
    return {"img": img}


@router.put("/books/{book_id}/order")
def reorder_pages(edit: PageOrder, book_id: str = Path(pattern=BOOK_ID)):
    """Reorder pages by their current keys; keys and `texts` follow. Replies with the book."""
    with lock:
        doc = books.find_one({"_id": book_id}, {"book": 1, "texts": 1})
        pages = doc and doc["book"][0]["Book"]["Pages"]
        if not pages:
            raise HTTPException(404, "no such book")
        if sorted(edit.order) != sorted(pages):
            raise HTTPException(400, "order must list every page once")
        keys = list(pages)
        texts = doc.get("texts", [])
        texts = [texts[keys.index(k)] if keys.index(k) < len(texts) else None for k in edit.order]
        book = book_json(doc["book"][0]["Book"]["Name"], {page_key(j): pages[k] for j, k in enumerate(edit.order)},
                          [], doc["book"][0]["Book"]["Characters"])
        books.update_one({"_id": book_id}, {"$set": {"book": book, "texts": texts, "updatedAt": datetime.now(timezone.utc)}})
    return book


@router.delete("/books/{book_id}/pages/{key}")
def delete_page(book_id: str = Path(pattern=BOOK_ID), key: str = Path(pattern=r"^(Cover|Page[A-Za-z]+)$")):
    """Delete one page and its image; later pages move up a key. The only page can't go. Replies with the book."""
    with lock:
        doc = books.find_one({"_id": book_id}, {"book": 1, "texts": 1})
        pages = doc and doc["book"][0]["Book"]["Pages"]
        if not pages or key not in pages:
            raise HTTPException(404, "no such page")
        if len(pages) == 1:
            raise HTTPException(400, "can't delete a book's only page")
        order = list(pages.values())
        i = list(pages).index(key)
        gone = order.pop(i)
        texts = doc.get("texts", [])
        if i < len(texts):
            del texts[i]
        book = book_json(doc["book"][0]["Book"]["Name"], {page_key(j): p for j, p in enumerate(order)},
                          [], doc["book"][0]["Book"]["Characters"])
        books.update_one({"_id": book_id}, {"$set": {"book": book, "texts": texts, "updatedAt": datetime.now(timezone.utc)}})
    # ponytail: os.path.basename keeps a stored img name inside the book's folder
    for img in (os.path.join(IMG_DIR, book_id, os.path.basename(gone["img"])), *version_paths(book_id, gone["img"])):
        if os.path.isfile(img):
            os.remove(img)
    return book


@router.delete("/books/{book_id}", status_code=204)
def delete_book(book_id: str = Path(pattern=BOOK_ID)):
    """Remove the book from MongoDB and its page images from disk. The id pattern keeps the path inside IMG_DIR."""
    deleted.add(book_id) # first, even before anything is saved (404)
    with lock:  # not in the middle of adding a page to it
        doc = books.find_one({"_id": book_id}, {"book": 1})
        if books.delete_one({"_id": book_id}).deleted_count == 0:
            raise HTTPException(404, "no such book")
        shutil.rmtree(os.path.join(IMG_DIR, book_id), ignore_errors=True)  # may already be gone
    _drop_files(book_id, doc)


def _uses(doc):
    """(sound ids, line texts) a book doc uses."""
    sounds, lines = set(), set()
    for page in (doc or {}).get("book", [{}])[0].get("Book", {}).get("Pages", {}).values():
        picked = page.get("sounds") or {}
        sounds |= {s["id"] for s in [picked.get("setting"), *(picked.get("lines") or {}).values()] if s}
        lines |= {l["Dialogue"].strip() for l in page.get("text", [])}
    return sounds, lines


def _drop_files(book_id, doc):
    """Delete a removed book's sound files and voice clips no other book uses; cue sounds are kept"""
    sounds, lines = _uses(doc)
    for other in books.find({}, {"book": 1}):
        s, l = _uses(other)
        sounds -= s
        lines -= l
    for cue in CUES.values():
        sounds.discard(elevenlabs.sound_id(cue, "effect"))
        hit = freesound.cache.find_one({"_id": f"effect|{cue}"}) or {}
        sounds -= {c["id"] for c in (hit.get("candidates") or [])[:1]}
    paths = [os.path.join(elevenlabs.FILE_DIR, f"{s}.mp3") for s in sounds]
    paths += [vertex.clip_path(t, v) for t in lines if t for v in VOICES.values()]
    removed = {"sfx": 0, "tts": 0}
    for path in paths:
        try:
            os.remove(path)
            removed["sfx" if path.endswith(".mp3") else "tts"] += 1
        except FileNotFoundError:
            pass
    print(f"book {book_id}: removed {removed['sfx']} sounds, {removed['tts']} voice clips", flush=True)
