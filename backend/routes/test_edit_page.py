"""Check Edit Book's page save. Run from the repo root: python -m backend.routes.test_edit_page (needs MongoDB only)."""
from fastapi import HTTPException
from pydantic import ValidationError

import asyncio
import os

import backend.clients.arc as arc
from backend.config import IMG_DIR
from backend.db import books
from backend.routes.books import (Flag, PageEdit, PageOrder, delete_page, edit_page, flag_page, list_books,
                                  reorder_pages, set_face)
from backend.routes.scan import commit_page, image_name

BOOK = "zz-test-edit"  # throwaway id, deleted at the end


class Body:  # stands in for the Request set_face reads the JPEG from
    def __init__(self, data):
        self.data = data

    async def body(self):
        return self.data


def face(name, data=b"\xff\xd8 fake jpeg"):
    return asyncio.run(set_face(Body(data), BOOK, name))


def offline(prompt):
    raise RuntimeError("offline")


arc.chat = offline  # speakers from the rules alone (book_builder falls back to them), no network

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

    # Cast screen face crops: stored on the character, kept through page edits, replaced files deleted
    zoe = lambda: next(c for c in books.find_one({"_id": BOOK})["book"][0]["Book"]["Characters"] if c["Name"] == "Zoe")  # noqa: E731
    first = face("Zoe")["img"]
    assert zoe()["img"] == first and os.path.isfile(os.path.join(IMG_DIR, BOOK, first))
    edit_page(PageEdit(text=[{"Character": "Zoe", "Dialogue": '"Who is there?"'},
                             {"Character": "Narrator", "Dialogue": "She looked around."}]), BOOK, "PageOne")
    assert zoe()["img"] == first  # a page edit rebuilds Characters but keeps the face
    second = face("Zoe")["img"]
    assert second != first and zoe()["img"] == second and not os.path.exists(os.path.join(IMG_DIR, BOOK, first))
    for name, data, code in (("Zoe", b"not a jpeg", 400), ("Nobody", b"\xff\xd8", 404)):
        try:
            face(name, data)
            raise AssertionError(f"expected {code}")
        except HTTPException as e:
            assert e.status_code == code

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
    # the title only changes by editing the cover's lines; other pages' edits leave it
    cover = books.find_one({"_id": BOOK})["book"][0]["Book"]["Pages"]["Cover"]["text"]
    edit_page(PageEdit(text=[{"Character": "Narrator", "Dialogue": "The Very Hungry"},
                             {"Character": "Narrator", "Dialogue": "Caterpillar"}]), BOOK, "Cover")
    assert row()["name"] == "The Very Hungry Caterpillar", row()
    edit_page(PageEdit(text=[{"Character": "Zoe", "Dialogue": '"Who is there?"'}]), BOOK, "PageOne")
    assert row()["name"] == "The Very Hungry Caterpillar"
    edit_page(PageEdit(text=[{"Character": l["Character"], "Dialogue": l["Dialogue"]} for l in cover]), BOOK, "Cover")
    # flags: shown per page in the Library row, kept through line edits, cleared by unflagging
    assert row()["flagged"] == []
    flag_page(Flag(flagged=True), BOOK, "PageOne")
    assert row()["flagged"] == [2], row()
    edit_page(PageEdit(text=[{"Character": "Zoe", "Dialogue": '"Who is there?"'}]), BOOK, "PageOne")
    assert row()["flagged"] == [2]
    try:
        flag_page(Flag(flagged=True), BOOK, "PageNine")
        raise AssertionError("expected 404")
    except HTTPException as e:
        assert e.status_code == 404

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
    flag_page(Flag(flagged=True), BOOK, "Cover")  # the flag follows its page when it moves
    reorder_pages(PageOrder(order=["PageOne", "Cover"]), BOOK)
    assert row()["flagged"] == [2], row()
    flag_page(Flag(flagged=False), BOOK, "PageOne")
    assert row()["flagged"] == []
    reorder_pages(PageOrder(order=["PageOne", "Cover"]), BOOK)  # back to the order the checks below expect
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

    cover_img = books.find_one({"_id": BOOK})["book"][0]["Book"]["Pages"]["Cover"]["img"]
    version = os.path.join(IMG_DIR, BOOK, "alt",
                           os.path.splitext(os.path.basename(cover_img))[0] + "_20261120-120000-000000.png")
    os.makedirs(os.path.dirname(version), exist_ok=True)
    open(version, "wb").close()  # a fingerprint version from a reading (scan.add_version)
    delete_page(BOOK, "Cover")
    assert not os.path.exists(version)  # deleted with its page
    try:
        delete_page(BOOK, "Cover")
        raise AssertionError("expected 400")
    except HTTPException as e:
        assert e.status_code == 400
    print("ok")
finally:
    books.delete_one({"_id": BOOK})
