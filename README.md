# computer-vision-book

Turns photos of book pages into book JSON (like `data/Book2.js`): flip + unwarp each photo, OCR it with VT ARC's LLM API, then split the text into lines and assign each line to the Narrator or a character.

## Layout
```
main.py                 run the whole pipeline: data/test_img/ -> output/ -> output/book.json
unwarp/                 page flattening (UVDoc model): unwarp_flip.py, model.py, utils.py
ocr/                    VT LLM API client: ocr.py (chat(), ocr()), test_ocr.py
book/                   book_builder.py (lines + speakers -> JSON), clean_ocr.py (text normalizing)
weights/best_model.pkl  unwarp model weights
data/                   input photos (test_img/) and the example book (Book2.js)
output/                 generated, gitignored
```

## Setup
```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements_demo.txt
```
Put `LLM_API_KEY=...` in `.env` (key from llm.arc.vt.edu → Settings → Account → API keys).

## Run (from the repo root)
```bash
python main.py                                         # full pipeline
python -m unwarp.unwarp_flip --img-path photo.jpg      # flip + unwarp one image or folder
python -m ocr.ocr page.png                             # OCR one image
python -m book.book_builder output --out book.json     # build a book from unwarped pages
python -m ocr.test_ocr                                 # live API tests
```
