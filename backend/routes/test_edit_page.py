"""Check Edit Book's page save. Run from the repo root: python -m backend.routes.test_edit_page (needs MongoDB only)."""
from fastapi import HTTPException
from pydantic import ValidationError

from backend.db import books
from backend.routes.books import PageEdit, PageOrder, delete_page, edit_page, list_books, reorder_pages
from backend.routes.scan import commit_page, image_name

BOOK = "zz-test-edit"  # throwaway id, deleted at the end

try:
    books.delete_one({"_id": BOOK})
    commit_page(BOOK, 0, "page_001.png", "The Big Day", {})
    commit_page(BOOK, 1, "page_002.png", '"Who?" She looked around.', {})
    before = books.find_one({"_id": BOOK})["book"][0]["Book"]["Pages"]["Cover"]
    row = lambda: next(r for r in list_books() if r["id"] == BOOK)  # noqa: E731
    assert row()["unknown"] == [2], row()  # "Who?" has no speaker tag and no names are known -> Unknown on page 2

    book = edit_page(PageEdit(text=[{"Character": " Zoe ", "Dialogue": '"Who is there?"'},
                                    {"Character": "Narrator", "Dialogue": "She looked around."}]), BOOK, "PageOne")
    pages = books.find_one({"_id": BOOK})["book"][0]["Book"]["Pages"]
    assert book[0]["Book"]["Pages"] == pages  # replies with what's stored
    assert [(l["Character"], l["Dialogue"]) for l in pages["PageOne"]["text"]] == \
        [("Zoe", '"Who is there?"'), ("Narrator", "She looked around.")], pages["PageOne"]
    assert pages["Cover"] == before  # other pages untouched
    assert [c["Name"] for c in book[0]["Book"]["Characters"]] == ["Narrator", "Zoe"]  # "Unknown" gone, Zoe added
    assert row()["unknown"] == []  # flag cleared in the Library

    try:
        edit_page(PageEdit(text=[]), BOOK, "PageNine")
        raise AssertionError("expected 404")
    except HTTPException as e:
        assert e.status_code == 404
    try:
        PageEdit(text=[{"Character": "", "Dialogue": "x"}])
        raise AssertionError("expected a validation error")
    except ValidationError:
        pass
    # delete page: later pages move up a key, texts stays one per page, the only page can't go
    commit_page(BOOK, 2, "page_003.png", "The end.", {})
    book = delete_page(BOOK, "PageOne")
    doc = books.find_one({"_id": BOOK})
    pages = doc["book"][0]["Book"]["Pages"]
    assert book[0]["Book"]["Pages"] == pages
    assert list(pages) == ["Cover", "PageOne"] and pages["PageOne"]["img"] == "page_003.png", pages
    assert doc["texts"] == ["The Big Day", "The end."], doc["texts"]
    assert [c["Name"] for c in book[0]["Book"]["Characters"]] == ["Narrator"]  # Zoe only spoke on the deleted page

    # reorder: keys follow the new positions, texts move with their pages
    book = reorder_pages(PageOrder(order=["PageOne", "Cover"]), BOOK)
    doc = books.find_one({"_id": BOOK})
    assert [p["img"] for p in doc["book"][0]["Book"]["Pages"].values()] == ["page_003.png", "page_001.png"]
    assert doc["texts"] == ["The end.", "The Big Day"], doc["texts"]
    for bad in (["Cover"], ["Cover", "Cover"], ["Cover", "PageNine"]):
        try:
            reorder_pages(PageOrder(order=bad), BOOK)
            raise AssertionError(f"expected 400 for {bad}")
        except HTTPException as e:
            assert e.status_code == 400
    # a page added after that doesn't take a live page's image name; a retry of an existing page keeps its own
    assert image_name(BOOK, 2) == "page_003_1.png"  # page_003.png is now the cover's
    assert image_name(BOOK, 1) == "page_002.png"  # free
    assert image_name(BOOK, 0) == "page_001_1.png"  # page_001.png is PageOne's now

    delete_page(BOOK, "Cover")
    try:
        delete_page(BOOK, "Cover")
        raise AssertionError("expected 400")
    except HTTPException as e:
        assert e.status_code == 400
    print("ok")
finally:
    books.delete_one({"_id": BOOK})
