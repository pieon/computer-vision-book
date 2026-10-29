"""Normalize OCR/answer text so formatting differences don't count as errors.
Usage: python -m book.clean_ocr file.txt|file.csv  -> writes file_clean.txt|file_clean.csv"""
import csv
import os
import re
import sys

# OCR often returns straight quotes where the book uses curly ones
QUOTES = str.maketrans({"“": '"', "”": '"', "‘": "'", "’": "'"})


def normalize(text):
    text = " ".join(text.translate(QUOTES).split())  # line breaks/extra spaces -> one space
    text = re.sub(r"(\w)- ?(\w)", r"\1\2", text)      # moun-tain / dino- saur -> mountain / dinosaur
    text = re.sub(r" ?\.\.\.", "...", text)           # "be ..." -> "be..."
    return text


def clean_file(path):
    root, ext = os.path.splitext(path)
    out = f"{root}_clean{ext}"
    if ext.lower() == ".csv":
        # clean each cell so line breaks inside cells don't merge rows
        with open(path, newline="", encoding="utf-8") as f:
            rows = [[normalize(c) for c in row] for row in csv.reader(f)]
        with open(out, "w", newline="", encoding="utf-8") as f:
            csv.writer(f).writerows(rows)
    else:
        with open(path, encoding="utf-8") as f:
            text = normalize(f.read())
        with open(out, "w", encoding="utf-8") as f:
            f.write(text)
    return out


if __name__ == "__main__":
    assert normalize("“Hi,”\nhe said.\r\nOk.") == '"Hi," he said. Ok.'
    assert normalize("I said,  “Don’t.” ") == normalize('I said, "Don\'t."')
    assert normalize("the moun-tain") == normalize("the moun-\ntain") == "the mountain"
    assert normalize("It can't be ... thought") == "It can't be... thought"
    print(clean_file(sys.argv[1]))
