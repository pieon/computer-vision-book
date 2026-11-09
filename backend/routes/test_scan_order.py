"""Check that pages saved out of order end up in page order. Run from the repo root:
python -m backend.routes.test_scan_order (needs MongoDB, not the VPN: no unwarp or OCR, just the DB step)."""
from backend.db import books
from backend.routes.scan import commit_page

BOOK = "zz-test-order"  # throwaway id, deleted at the end


def test_out_of_order():
    books.delete_one({"_id": BOOK})
    try:
        texts = ["The Big Day", "Once there was a dog.", "The end."]
        for n in (2, 0, 1):  # like parallel OCR finishing in any order
            commit_page(BOOK, n, f"page_{n + 1:03d}.png", texts[n], {})
        doc = books.find_one({"_id": BOOK})
        pages = doc["book"][0]["Book"]["Pages"]
        assert list(pages) == ["Cover", "PageOne", "PageTwo"], list(pages)
        assert [p["img"] for p in pages.values()] == ["page_001.png", "page_002.png", "page_003.png"]
        assert doc["texts"] == texts
        print("ok", list(pages))
    finally:
        books.delete_one({"_id": BOOK})


def test_gap_while_processing():
    books.delete_one({"_id": BOOK})
    try:
        commit_page(BOOK, 2, "page_003.png", "The end.", {})  # pages 0 and 1 still processing
        doc = books.find_one({"_id": BOOK})
        assert doc["texts"] == [None, None, "The end."]
        assert list(doc["book"][0]["Book"]["Pages"]) == ["PageTwo"]
    finally:
        books.delete_one({"_id": BOOK})


if __name__ == "__main__":
    test_out_of_order()
    test_gap_while_processing()
