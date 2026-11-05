"""Book scanner backend: wires the routes together. Run from the repo root: python -m backend
(frontend/vite.config.js proxies /scan, /books, /images and /stats here). Each feature is one module in routes/."""
import os

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from backend.config import IMG_DIR
from backend.routes import books, listen, question_acknowledgment, scan, stats, tts

app = FastAPI()
for feature in (scan, books, stats, listen, tts, question_acknowledgment):
    app.include_router(feature.router)

os.makedirs(IMG_DIR, exist_ok=True)
# page images by URL, e.g. /images/<id>/page_001.png (the library uses page 1 as the cover); StaticFiles blocks ../
# ponytail: full-size PNG as the cover; serve small thumbnails if the library gets slow with many books
app.mount("/images", StaticFiles(directory=IMG_DIR), name="images")
