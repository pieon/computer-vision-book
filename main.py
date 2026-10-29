"""Flip+unwarp data/test_img/ -> output/, then build the book JSON from it."""
import json
import os

import torch

from book.book_builder import build_book
from unwarp.unwarp_flip import unwarp_img
from unwarp.utils import IMG_SIZE, load_model

IMG_DIR = "data/test_img"
OUT_DIR = "output"
BOOK_NAME = os.path.basename(IMG_DIR)


def save_book(img_dir, out_json):
    book = build_book(img_dir, BOOK_NAME)  # build first so a failure doesn't leave an empty file
    with open(out_json, "w", encoding="utf-8") as f:
        json.dump(book, f, ensure_ascii=False, indent=2)
    print(f"-> {out_json}")


if __name__ == "__main__":
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    model = load_model("weights/best_model.pkl")
    model.to(device)
    model.eval()

    os.makedirs(OUT_DIR, exist_ok=True)
    names = sorted(f for f in os.listdir(IMG_DIR) if f.lower().endswith((".jpg", ".jpeg", ".png")))
    for i, name in enumerate(names, 1):
        print(f"[unwarp {i}/{len(names)}] {name}")
        out_path = os.path.join(OUT_DIR, os.path.splitext(name)[0] + "_unwarp.png")
        unwarp_img(model, device, os.path.join(IMG_DIR, name), IMG_SIZE, out_path)

    save_book(OUT_DIR, os.path.join(OUT_DIR, "book.json"))
