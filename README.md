# computer-vision-book

Turns photos of book pages into book JSON (like `data/Book2.js`): flip + unwarp each photo, OCR it with VT ARC's LLM API, then split the text into lines and assign each line to the Narrator or a character.

## Layout
```
backend/                FastAPI server: python -m backend
  app.py                creates the app and registers each route module
  config.py             repo paths and .env loading
  db.py                 MongoDB collections + the processing lock
  routes/               one file per feature: scan.py, books.py, stats.py
  clients/              outside APIs, one module per provider: arc.py (VT ARC LLM: chat(), decide())
  pipeline/             processing, no HTTP or DB: unwarp/ (UVDoc), ocr.py, book/ (lines + speakers -> JSON)
frontend/               React + Vite PWA: npm run dev
  src/api.js            every backend request goes through here
  src/pages/            one screen each: Home, Library, Book, Scanner
  src/components/       shared pieces: TabBar, icons
scripts/build_book.py   offline batch: data/test_img/ -> output/ -> output/book.json
weights/best_model.pkl  unwarp model weights
data/                   input photos (test_img/) and the example book (Book2.js)
output/                 generated, gitignored
```
Adding a feature: a new `backend/routes/<name>.py` (plus one line in `app.py`), a new API provider in `backend/clients/`, a new screen in `frontend/src/pages/`.

## Setup
```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python -c "import nltk; nltk.download('wordnet')"   # people/animal check for speaker names
```
MongoDB (books are stored in `bookscanner.books`): `brew tap mongodb/brew && brew install mongodb-community && brew services start mongodb-community`. Set `MONGO_URL=...` in `.env` if it's not on `mongodb://localhost:27017`.

Put `LLM_API_KEY=...` in `.env` (key from llm.arc.vt.edu → Settings → Account → API keys).

## Run (from the repo root)
```bash
python -m backend                                                  # backend (pages -> MongoDB, images -> output/books/<id>/)
cd frontend && npm install && npm run dev                          # app, open https://<mac-ip>:5173 on the tablet
python -m scripts.build_book                                       # offline full pipeline
python -m backend.pipeline.unwarp.unwarp_flip --img-path photo.jpg # flip + unwarp one image or folder
python -m backend.pipeline.ocr page.png                            # OCR one image
python -m backend.pipeline.book.book_builder output --out book.json # build a book from unwarped pages
python -m backend.pipeline.test_ocr                                # live API tests (needs the VT VPN)
```
