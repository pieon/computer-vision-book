"""The library: list books, one book's JSON, delete a book."""
import os
import shutil

from fastapi import APIRouter, HTTPException, Path
from backend.config import IMG_DIR
from backend.db import BOOK_ID, books, lock

router = APIRouter()


@router.get("/books")
def list_books():
    """Library: newest first, just what a book tile needs (not the texts or pages); cover = page 1's image file."""
    return list(books.aggregate([
        {"$sort": {"createdAt": -1}},
        {"$project": {"_id": 0, "id": "$_id", "name": {"$first": "$book.Book.Name"},
                      "pages": {"$size": "$texts"}, "createdAt": 1,
                      "cover": {"$first": "$book.Book.Pages.Cover.img"}}},
    ]))


@router.get("/books/{book_id}")
def get_book(book_id: str = Path(pattern=BOOK_ID)):
    """One book's Book2 JSON, as stored."""
    doc = books.find_one({"_id": book_id}, {"book": 1})
    if not doc:
        raise HTTPException(404, "no such book")
    return doc["book"]


@router.delete("/books/{book_id}", status_code=204)
def delete_book(book_id: str = Path(pattern=BOOK_ID)):
    """Remove the book from MongoDB and its page images from disk. The id pattern keeps the path inside IMG_DIR."""
    with lock:  # not in the middle of adding a page to it
        if books.delete_one({"_id": book_id}).deleted_count == 0:
            raise HTTPException(404, "no such book")
        shutil.rmtree(os.path.join(IMG_DIR, book_id), ignore_errors=True)  # may already be gone
