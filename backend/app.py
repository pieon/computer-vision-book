"""Book scanner backend. Run from the repo root: python -m backend"""
import os

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from backend.config import IMG_DIR
from backend.routes import books, listen, question_acknowledgment, scan, sounds, stats, tts, turn

app = FastAPI()
for feature in (scan, turn, books, sounds, stats, listen, tts, question_acknowledgment):
    app.include_router(feature.router)

os.makedirs(IMG_DIR, exist_ok=True)
# page images, e.g. /images/<id>/page_001.png
# ponytail: full-size PNG covers; serve thumbnails if the library gets slow
app.mount("/images", StaticFiles(directory=IMG_DIR), name="images")
