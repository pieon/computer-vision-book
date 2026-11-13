"""The library: list books, one book's JSON, edit a page's lines, delete a book."""
import os
import shutil
from datetime import datetime, timezone
from typing import Annotated

from fastapi import APIRouter, HTTPException, Path
from pydantic import BaseModel, Field, StringConstraints

from backend.config import IMG_DIR
from backend.db import BOOK_ID, books, lock
from backend.pipeline.book.book_builder import book_json, page_key

router = APIRouter()


class Line(BaseModel):
    Character: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=40)]
    Dialogue: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=2000)]


class PageEdit(BaseModel):
    text: list[Line] = Field(max_length=200)


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
                                            "in": "$$this.v.text.Character"}}}},
    ]))
    for r in rows:
        r["unknown"] = [i + 1 for i, s in enumerate(r.pop("speakers", None) or []) if "Unknown" in s]
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
        book = book_json(doc["book"][0]["Book"]["Name"], pages, [])
        books.update_one({"_id": book_id}, {"$set": {"book": book, "updatedAt": datetime.now(timezone.utc)}})
    return book


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
        book = book_json(doc["book"][0]["Book"]["Name"], {page_key(j): pages[k] for j, k in enumerate(edit.order)}, [])
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
        book = book_json(doc["book"][0]["Book"]["Name"], {page_key(j): p for j, p in enumerate(order)}, [])
        books.update_one({"_id": book_id}, {"$set": {"book": book, "texts": texts, "updatedAt": datetime.now(timezone.utc)}})
    # ponytail: os.path.basename keeps a stored img name inside the book's folder
    img = os.path.join(IMG_DIR, book_id, os.path.basename(gone["img"]))
    if os.path.isfile(img):
        os.remove(img)
    return book


@router.delete("/books/{book_id}", status_code=204)
def delete_book(book_id: str = Path(pattern=BOOK_ID)):
    """Remove the book from MongoDB and its page images from disk. The id pattern keeps the path inside IMG_DIR."""
    with lock:  # not in the middle of adding a page to it
        if books.delete_one({"_id": book_id}).deleted_count == 0:
            raise HTTPException(404, "no such book")
        shutil.rmtree(os.path.join(IMG_DIR, book_id), ignore_errors=True)  # may already be gone
