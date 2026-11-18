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
from backend.pipeline.book.book_builder import book_json, page_key

router = APIRouter()


class Line(BaseModel):
    Character: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=40)]
    Dialogue: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=2000)]


class PageEdit(BaseModel):
    text: list[Line] = Field(max_length=200)


class Flag(BaseModel):
    flagged: bool


class BookName(BaseModel):
    name: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=120)]


class PageOrder(BaseModel):
    order: list[str] = Field(max_length=1000)  # every page key once, in the new order


@router.get("/books")
def list_books():
    """Library: newest first, just what a book tile needs (not the texts or pages); cover = page 1's image file;
    unknown = page numbers (1 = Cover, as in Edit Book) with a line whose speaker is "Unknown"."""
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


@router.put("/books/{book_id}/pages/{key}")
def edit_page(edit: PageEdit, book_id: str = Path(pattern=BOOK_ID), key: str = Path(pattern=r"^(Cover|Page[A-Za-z]+)$")):
    """Edit Book (BookEditor.jsx): replace one page's lines and speakers. Characters is rebuilt from the speakers now
    used in the whole book. The raw OCR (`texts`) is kept as scanned. Replies with the updated book JSON."""
    with lock:  # not while a scanned page is being added to it
        doc = books.find_one({"_id": book_id}, {"book": 1})
        pages = doc and doc["book"][0]["Book"]["Pages"]
        if not pages or key not in pages:
            raise HTTPException(404, "no such page")
        pages[key]["text"] = [{"Reading": False, "Character": l.Character, "Dialogue": l.Dialogue} for l in edit.text]
        book = book_json(doc["book"][0]["Book"]["Name"], pages,
                          [], doc["book"][0]["Book"]["Characters"])
        books.update_one({"_id": book_id}, {"$set": {"book": book, "updatedAt": datetime.now(timezone.utc)}})
    return book


@router.put("/books/{book_id}/pages/{key}/flag")
def flag_page(flag: Flag, book_id: str = Path(pattern=BOOK_ID), key: str = Path(pattern=r"^(Cover|Page[A-Za-z]+)$")):
    """The reader's flag button (Book.jsx), or unflagging in Edit Book: mark a page as needing a fix. Stored on the
    page itself, so it moves with the page on reorder and stays through line edits. The key pattern has no . or $,
    so it's safe in the dotted path."""
    path = f"book.0.Book.Pages.{key}"
    with lock:
        r = books.update_one({"_id": book_id, path: {"$exists": True}}, {"$set": {f"{path}.flagged": flag.flagged}})
    if not r.matched_count:
        raise HTTPException(404, "no such page")
    return {"flagged": flag.flagged}


@router.put("/books/{book_id}/name")
def rename_book(edit: BookName, book_id: str = Path(pattern=BOOK_ID)):
    """Edit Book (PageList.jsx): tap the title to rename the book. Replies {"name": the stored name}."""
    with lock:
        r = books.update_one({"_id": book_id}, {"$set": {"book.0.Book.Name": edit.name,
                                                         "updatedAt": datetime.now(timezone.utc)}})
    if not r.matched_count:
        raise HTTPException(404, "no such book")
    return {"name": edit.name}


@router.put("/books/{book_id}/face")
async def set_face(request: Request, book_id: str = Path(pattern=BOOK_ID), name: str = Query(min_length=1)):
    """Cast screen (Cropper.jsx): the body is a JPEG cropped from a page, the picture shown next to character `name`.
    Saved as face_<ms>.jpg (a new name each time, so no stale cached crop); the old one is deleted. Replies {"img"}.
    ponytail: a character dropped by a later edit leaves its face file on disk until the book is deleted."""
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
    """Pages list: put the pages in a new order, given as the current keys. Keys are reassigned by position
    (first = Cover, then PageOne, ...) and `texts` is reordered to match. Replies with the updated book JSON."""
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
    """Edit Book: remove one page and its image. Later pages move up a key (PageTwo -> PageOne, ...; deleting the
    Cover makes PageOne the cover), and `texts` drops the same slot so it stays one per page. Image files keep their
    names. A book's only page can't be deleted (delete the book). Replies with the updated book JSON."""
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
    img = os.path.join(IMG_DIR, book_id, os.path.basename(gone["img"]))
    if os.path.isfile(img):
        os.remove(img)
    return book


@router.delete("/books/{book_id}", status_code=204)
def delete_book(book_id: str = Path(pattern=BOOK_ID)):
    """Remove the book from MongoDB and its page images from disk. The id pattern keeps the path inside IMG_DIR."""
    deleted.add(book_id)  # first, even if nothing is saved yet (404): pages still processing are dropped (scan.py)
    with lock:  # not in the middle of adding a page to it
        if books.delete_one({"_id": book_id}).deleted_count == 0:
            raise HTTPException(404, "no such book")
        shutil.rmtree(os.path.join(IMG_DIR, book_id), ignore_errors=True)  # may already be gone
